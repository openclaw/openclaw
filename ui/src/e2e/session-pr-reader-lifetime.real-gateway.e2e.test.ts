import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../../src/config/sessions/session-accessor.ts";
import { GatewayClient, isGatewayProtocolResponseError } from "../../../src/gateway/client.ts";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.ts";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { racePromiseWithAbortSignal } from "../../../src/infra/abort-signal.ts";
import { loadOrCreateDeviceIdentity } from "../../../src/infra/device-identity.ts";
import { createDeferredCore } from "../../../src/shared/deferred.ts";
import {
  ensureProfileForEmail,
  linkEmail,
  resolveUserProfileId,
  setDisplayName,
  setUserProfileRole,
} from "../../../src/state/user-profiles.ts";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:pr-reader-lifetime";
const checksMethod = "controlUi.sessionPullRequests.checks";
const viewerEmail = "pr-viewer@example.test";
const retiringEmail = "retiring-pr-reader@example.test";
const viewport = { width: 1180, height: 800 };
const execFileAsync = promisify(execFile);
const suite = createControlUiE2eSuite({
  name: "Session PR readers through a real Gateway",
  startServerBeforeBrowser: true,
});

type Repository = {
  root: string;
  repo: string;
  branch: string;
  headSha: string;
  number: number;
  additions: number;
  checkName?: string;
};
type Delivery = { number: number; repo: string; branch: string; additions?: number };

async function createRepository(
  state: OpenClawTestState,
  repo: string,
  number: number,
): Promise<Repository> {
  const root = state.path(repo);
  const branch = `feature/${repo}`;
  await mkdir(root, { recursive: true });
  const git = async (...args: string[]) =>
    (await execFileAsync("git", args, { cwd: root, env: state.env })).stdout.trim();
  await git("init", "--initial-branch=main");
  await writeFile(path.join(root, "README.md"), `# ${repo}\n`);
  await git("add", "README.md");
  await git(
    "-c",
    "user.name=PR Reader Proof",
    "-c",
    "user.email=pr-reader@example.test",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-m",
    "test: initialize review workspace",
  );
  await git("remote", "add", "origin", `https://github.com/synthetic/${repo}.git`);
  await git("update-ref", "refs/remotes/origin/main", "HEAD");
  await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  await git("checkout", "-b", branch);
  return { root, repo, branch, number, additions: 4, headSha: await git("rev-parse", "HEAD") };
}

function pullRequest(repository: Repository) {
  return {
    number: repository.number,
    title: `Review ${repository.repo}`,
    html_url: `https://github.com/synthetic/${repository.repo}/pull/${repository.number}`,
    state: "open",
    draft: false,
    merged_at: null,
    head: { ref: repository.branch, sha: repository.headSha },
    base: { ref: "main", repo: { name: repository.repo, owner: { login: "synthetic" } } },
    additions: repository.additions,
    deletions: 1,
    changed_files: 1,
  };
}

function deliveryFrom(payload: unknown): Delivery | undefined {
  if (!isRecord(payload) || !isRecord(payload.sessions)) {
    return undefined;
  }
  const snapshot = payload.sessions[sessionKey];
  const pull =
    isRecord(snapshot) && Array.isArray(snapshot.pullRequests)
      ? snapshot.pullRequests[0]
      : undefined;
  return isRecord(pull) &&
    typeof pull.number === "number" &&
    typeof pull.repo === "string" &&
    typeof pull.branch === "string"
    ? {
        number: pull.number,
        repo: pull.repo,
        branch: pull.branch,
        additions: typeof pull.additions === "number" ? pull.additions : undefined,
      }
    : undefined;
}

function summarizeChecks(ok: boolean, payload?: unknown, errorCode?: string) {
  const result = isRecord(payload) ? payload : undefined;
  return {
    ok,
    errorCode,
    repo: typeof result?.repo === "string" ? result.repo : undefined,
    number: typeof result?.number === "number" ? result.number : undefined,
    status: typeof result?.status === "string" ? result.status : undefined,
    checks: Array.isArray(result?.checks)
      ? result.checks.flatMap((check) =>
          isRecord(check) && typeof check.name === "string" ? [check.name] : [],
        )
      : [],
  };
}

async function refreshFromBrowser(page: Page) {
  return page.evaluate(
    async ({ method, sessionKey: requestedKey }) => {
      const app = document.querySelector("openclaw-app") as HTMLElement & {
        runtime: { context: { gateway: ApplicationGateway } };
      };
      const client = app?.runtime.context.gateway.snapshot.client;
      if (!client) {
        throw new Error("Control UI Gateway client is unavailable");
      }
      await client.request(method, {
        sessionKeys: [requestedKey],
        refreshSessionKeys: [requestedKey],
      });
      return app.runtime.context.gateway.snapshot.hello?.auth?.scopes;
    },
    { method: SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, sessionKey },
  );
}

suite.define(() => {
  it("keeps session PR and CI results with the current workspace and reader", async (test) => {
    let state: OpenClawTestState | undefined;
    let gateway: GatewayServer | undefined;
    let proxy: ViteDevServer | undefined;
    let retiringReader: GatewayClient | undefined;
    let restoreFetch: (() => void) | undefined;
    const providerEntered = createDeferredCore();
    const releaseProvider = createDeferredCore();
    const snapshotEntered = createDeferredCore();
    const checksEntered = createDeferredCore();
    const releaseIdentityReads = createDeferredCore();
    await suite.runScenario(test, {
      retainedState: () => state?.root,
      async run(signal) {
        state = await createOpenClawTestState({
          label: "session-pr-reader-lifetime",
          layout: "home",
          env: {
            GH_TOKEN: undefined,
            GITHUB_TOKEN: undefined,
            OPENCLAW_GATEWAY_PASSWORD: undefined,
            OPENCLAW_GATEWAY_TOKEN: undefined,
            OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
            OPENCLAW_SKIP_CANVAS_HOST: "1",
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_SKIP_CRON: "1",
            OPENCLAW_SKIP_GMAIL_WATCHER: "1",
            OPENCLAW_SKIP_PROVIDERS: "1",
            OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
            VITEST: "1",
          },
        });
        const original = await createRepository(state, "original-workspace", 101);
        const replacement = await createRepository(state, "replacement-workspace", 202);
        const viewer = ensureProfileForEmail(viewerEmail);
        const retiring = ensureProfileForEmail(retiringEmail);
        for (const [profile, name] of [
          [viewer, "Review viewer"],
          [retiring, "Retiring reader"],
        ] as const) {
          setDisplayName(profile.id, name);
          setUserProfileRole(profile.id, "reader");
        }
        const port = await getFreePort();
        const origin = new URL(suite.server.baseUrl).origin;
        const trustedProxy = {
          allowLoopback: true,
          allowUsers: [viewerEmail, retiringEmail],
          deviceAutoApprove: { enabled: true, scopes: ["operator.read"] },
          requiredHeaders: ["x-forwarded-proto"],
          userHeader: "x-forwarded-user",
        };
        await state.writeConfig({
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              model: { primary: "openai/gpt-4.1" },
            },
            entries: { main: {} },
          },
          gateway: {
            port,
            auth: { mode: "trusted-proxy", trustedProxy },
            trustedProxies: ["127.0.0.1", "::1"],
            controlUi: { enabled: false, allowedOrigins: [origin] },
            roles: {
              default: "reader",
              definitions: {
                reader: {
                  agents: ["main"],
                  sessions: { others: "view" },
                  scopes: ["operator.read"],
                },
              },
            },
          },
        });
        const entry = {
          sessionId: "00000000-0000-4000-8000-000000000101",
          label: "Workspace review",
          updatedAt: Date.now(),
          spawnedCwd: original.root,
          createdActor: { type: "human", source: "profile", id: viewer.id } as const,
        };
        replaceSessionEntrySync({ agentId: "main", sessionKey }, entry);

        let holdOriginal = false;
        let holdSnapshot = false;
        let holdChecks = false;
        const realFetch = globalThis.fetch;
        const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
          const url = new URL(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          );
          if (url.hostname !== "api.github.com") {
            return realFetch(input, init);
          }
          const repository = [original, replacement].find((item) =>
            url.pathname.startsWith(`/repos/synthetic/${item.repo}/`),
          );
          if (!repository) {
            throw new Error(`Unexpected synthetic GitHub request: ${url.pathname}`);
          }
          const json = (body: unknown) =>
            new Response(JSON.stringify(body), {
              headers: { "Content-Type": "application/json" },
            });
          if (url.pathname.endsWith("/pulls")) {
            if (url.searchParams.get("head") !== `synthetic:${repository.branch}`) {
              throw new Error("GitHub lookup did not use the recorded checkout branch");
            }
            if (repository === original && holdOriginal) {
              providerEntered.resolve();
              await releaseProvider.promise;
            }
            if (repository === replacement && holdSnapshot) {
              holdSnapshot = false;
              snapshotEntered.resolve();
              await releaseIdentityReads.promise;
            }
            return json([pullRequest(repository)]);
          }
          if (url.pathname.includes("/pulls/")) {
            if (repository === replacement && holdChecks) {
              holdChecks = false;
              checksEntered.resolve();
              await releaseIdentityReads.promise;
            }
            return json(pullRequest(repository));
          }
          if (url.pathname.endsWith("/check-runs")) {
            return json({
              total_count: 1,
              check_runs: [
                {
                  id: repository.number,
                  name: repository.checkName ?? `${repository.repo} check`,
                  head_sha: repository.headSha,
                  status: "completed",
                  conclusion: "success",
                  app: { slug: "synthetic-ci" },
                },
              ],
            });
          }
          throw new Error(`Unexpected synthetic GitHub request: ${url.pathname}`);
        });
        restoreFetch = () => transport.mockRestore();
        const { startGatewayServer } = await import("../../../src/gateway/server.js");
        gateway = await startGatewayServer(port, {
          auth: { mode: "trusted-proxy", trustedProxy },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        const forwarded = (email: string) => ({
          "x-forwarded-for": "192.0.2.10",
          "x-forwarded-proto": "http",
          "x-forwarded-user": email,
        });
        // Chromium does not consistently apply extraHTTPHeaders to WebSocket upgrades.
        proxy = await createServer({
          configFile: false,
          envFile: false,
          root: state.workspaceDir,
          appType: "custom",
          logLevel: "error",
          server: {
            host: "127.0.0.1",
            port: 0,
            proxy: {
              "/retiring": {
                target: `http://127.0.0.1:${port}`,
                ws: true,
                headers: forwarded(retiringEmail),
                rewrite: () => "/",
              },
              "/": {
                target: `http://127.0.0.1:${port}`,
                ws: true,
                headers: forwarded(viewerEmail),
              },
            },
          },
        });
        await proxy.listen();
        const proxyUrl = proxy.resolvedUrls?.local[0];
        if (!proxyUrl) {
          throw new Error("PR reader fixture proxy did not expose a loopback URL");
        }
        const browserGatewayUrl = new URL(proxyUrl);
        browserGatewayUrl.protocol = "ws:";
        const connected = createDeferredCore<string[]>();
        const retiredDeliveries: Delivery[] = [];
        retiringReader = new GatewayClient({
          url: new URL("retiring", browserGatewayUrl).href,
          origin,
          clientName: "openclaw-control-ui",
          mode: "webchat",
          role: "operator",
          scopes: ["operator.read"],
          deviceIdentity: loadOrCreateDeviceIdentity({
            env: state.env,
            identityKey: "retiring-pr-reader",
          }),
          sharedStateMode: "read-only",
          onHelloOk: (hello) => connected.resolve(hello.auth?.scopes ?? []),
          onConnectError: connected.reject,
          onClose: () =>
            connected.reject(new Error("PR reader connection closed before readiness")),
          onEvent: (event) => {
            const delivery =
              event.event === CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT
                ? deliveryFrom(event.payload)
                : undefined;
            if (delivery) {
              retiredDeliveries.push(delivery);
            }
          },
        });
        retiringReader.start();
        expect(await racePromiseWithAbortSignal(connected.promise, signal)).toEqual([
          "operator.read",
        ]);
        const reader = retiringReader;
        const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
        const artifacts = capture ? suite.artifactDir : undefined;
        await suite.withPage(
          {
            viewport,
            colorScheme: "light",
            locale: "en-US",
            serviceWorkers: "block",
            ...(artifacts ? { recordVideo: { dir: artifacts, size: viewport } } : {}),
          },
          async ({ page }) => {
            await page.addInitScript(() =>
              localStorage.setItem(
                "openclaw:control-ui:community-invite",
                JSON.stringify({ dismissedAtMs: 1770000000000 }),
              ),
            );
            const initialDelivery = createDeferredCore<Delivery>();
            const changedDelivery = createDeferredCore<Delivery>();
            const replacementSummaryDelivery = createDeferredCore<Delivery>();
            const currentReaderDelivery = createDeferredCore<Delivery>();
            const delivered: Delivery[] = [];
            const checkResponses: ReturnType<typeof summarizeChecks>[] = [];
            const retiringCheckResponses: ReturnType<typeof summarizeChecks>[] = [];
            let waitingForReplacement = false;
            let identityReassigned = false;
            let beforeIdentityReassignment: number | undefined;
            page.on("websocket", (socket) => {
              const checks = new Set<string>();
              socket.on("framesent", ({ payload }) => {
                const frame: unknown = JSON.parse(String(payload));
                if (
                  isRecord(frame) &&
                  frame.method === checksMethod &&
                  typeof frame.id === "string"
                ) {
                  checks.add(frame.id);
                }
              });
              socket.on("framereceived", ({ payload }) => {
                const frame: unknown = JSON.parse(String(payload));
                if (!isRecord(frame)) {
                  return;
                }
                if (typeof frame.id === "string" && checks.delete(frame.id)) {
                  checkResponses.push(
                    summarizeChecks(
                      frame.ok === true,
                      frame.payload,
                      isRecord(frame.error) && typeof frame.error.code === "string"
                        ? frame.error.code
                        : undefined,
                    ),
                  );
                }
                const delivery =
                  frame.event === CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT
                    ? deliveryFrom(frame.payload)
                    : undefined;
                if (delivery) {
                  delivered.push(delivery);
                  initialDelivery.resolve(delivery);
                  if (waitingForReplacement && delivery.number !== 101) {
                    changedDelivery.resolve(delivery);
                  }
                  if (delivery.number === 203) {
                    replacementSummaryDelivery.resolve(delivery);
                  }
                  if (identityReassigned && delivery.number === 203 && delivery.additions === 5) {
                    currentReaderDelivery.resolve(delivery);
                  }
                }
              });
            });
            const url = new URL(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
            url.hash = new URLSearchParams({ gatewayUrl: browserGatewayUrl.href }).toString();
            await page.goto(url.href);
            await page
              .locator("openclaw-gateway-url-confirmation")
              .getByRole("button", { name: `Switch to ${browserGatewayUrl.host}`, exact: true })
              .click();
            // Finish this browser's initial subscription load before timing the rendered PR state.
            expect(await racePromiseWithAbortSignal(initialDelivery.promise, signal)).toEqual({
              number: original.number,
              repo: original.repo,
              branch: original.branch,
              additions: original.additions,
            });
            const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
            const chip = pane.locator(".chat-pr").first();
            await chip.locator(".chat-pr__number").filter({ hasText: "#101" }).waitFor();
            await chip.locator(".chat-pr__checks-pill").click();
            await pane.getByText("original-workspace check", { exact: true }).waitFor();
            await page.keyboard.press("Escape");
            const screenshot = async (name: string) => {
              if (artifacts) {
                await writeFile(
                  path.join(artifacts, name),
                  await takeControlUiViewportScreenshot(page, page.locator("body"), [chip]),
                );
              }
            };
            const cue = async (text: string) => {
              if (artifacts) {
                await page.evaluate((message) => {
                  let label = document.getElementById("pr-reader-proof-action");
                  if (!label) {
                    label = document.createElement("output");
                    label.id = "pr-reader-proof-action";
                    label.style.cssText =
                      "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:8px 12px;border:1px solid currentColor;border-radius:6px;background:Canvas;color:CanvasText;font:13px system-ui;pointer-events:none";
                    document.body.append(label);
                  }
                  label.textContent = `Proof action: ${message}`;
                }, text);
              }
            };
            await cue("Original workspace loaded");
            await screenshot("01-original-workspace.png");
            await reader.request(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
              sessionKeys: [sessionKey],
            });
            await expect.poll(() => retiredDeliveries.length).toBe(1);

            // Change provider facts so settlement is observable even on the unfixed server.
            original.number = 102;
            holdOriginal = true;
            await reader.request(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
              sessionKeys: [sessionKey],
              refreshSessionKeys: [sessionKey],
            });
            await racePromiseWithAbortSignal(providerEntered.promise, signal);
            await reader.request(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, { sessionKeys: [] });
            const retiredCount = retiredDeliveries.length;
            await cue("Replace the workspace while the earlier GitHub refresh is held");
            waitingForReplacement = true;
            replaceSessionEntrySync(
              { agentId: "main", sessionKey },
              {
                ...entry,
                sessionId: "00000000-0000-4000-8000-000000000202",
                spawnedCwd: replacement.root,
                updatedAt: Date.now(),
              },
            );
            expect(await refreshFromBrowser(page)).toEqual(["operator.read"]);
            releaseProvider.resolve();
            const settled = await racePromiseWithAbortSignal(changedDelivery.promise, signal);
            await chip
              .locator(".chat-pr__number")
              .filter({ hasText: `#${settled.number}` })
              .waitFor();
            try {
              // Capture the real settled value before judging it: the baseline must retain its failure.
              await cue("Earlier refresh settled after workspace replacement");
              await screenshot("02-replacement-settled.png");
              expect(settled).toEqual({
                number: replacement.number,
                repo: replacement.repo,
                branch: replacement.branch,
                additions: replacement.additions,
              });
              expect(retiredDeliveries).toHaveLength(retiredCount);
              expect(await chip.locator(".chat-pr__link").getAttribute("href")).toBe(
                `https://github.com/synthetic/${replacement.repo}/pull/${replacement.number}`,
              );
              await chip.locator(".chat-pr__checks-pill").click();
              await pane.getByText("replacement-workspace check", { exact: true }).waitFor();
              await screenshot("03-current-checks.png");

              await chip.locator(".chat-pr__checks-pill").click();
              // A new PR keeps the details request cold while the real summary is already known.
              replacement.number = 203;
              replacement.checkName = "replacement-workspace current-reader check";
              expect(await refreshFromBrowser(page)).toEqual(["operator.read"]);
              // The subscription acknowledgement precedes the owner's paced refresh.
              expect(
                await racePromiseWithAbortSignal(replacementSummaryDelivery.promise, signal),
              ).toEqual({
                number: replacement.number,
                repo: replacement.repo,
                branch: replacement.branch,
                additions: replacement.additions,
              });
              await chip.locator(".chat-pr__number").filter({ hasText: "#203" }).waitFor();
              await reader.request(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
                sessionKeys: [sessionKey],
              });
              await expect.poll(() => retiredDeliveries.at(-1)?.number).toBe(203);
              beforeIdentityReassignment = retiredDeliveries.length;

              let rejectedChecks: unknown;
              holdChecks = true;
              const pendingChecks = reader
                .request(
                  checksMethod,
                  {
                    sessionKey,
                    owner: "synthetic",
                    repo: replacement.repo,
                    number: replacement.number,
                    headSha: replacement.headSha,
                  },
                  { signal },
                )
                .then(
                  (result) => summarizeChecks(true, result),
                  (error: unknown) => {
                    rejectedChecks = error;
                    return summarizeChecks(
                      false,
                      undefined,
                      isGatewayProtocolResponseError(error) ? error.code : "CLIENT_ERROR",
                    );
                  },
                )
                .then((result) => {
                  retiringCheckResponses.push(result);
                  return result;
                });
              await racePromiseWithAbortSignal(checksEntered.promise, signal);
              holdSnapshot = true;
              replacement.additions = 5;
              await reader.request(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
                sessionKeys: [sessionKey],
                refreshSessionKeys: [sessionKey],
              });
              await racePromiseWithAbortSignal(snapshotEntered.promise, signal);
              await cue("Reassign the retiring reader while its PR and CI reads are held");
              linkEmail(retiringEmail, viewer.id);
              identityReassigned = resolveUserProfileId(retiring.id) === viewer.id;
              expect(identityReassigned).toBe(true);

              expect(await refreshFromBrowser(page)).toEqual(["operator.read"]);
              releaseIdentityReads.resolve();
              const current = await racePromiseWithAbortSignal(
                currentReaderDelivery.promise,
                signal,
              );
              await pendingChecks;
              await chip.locator(".chat-pr__checks-pill").click();
              await pane.getByText(replacement.checkName, { exact: true }).waitFor();
              // The response drains earlier frames on this socket after the shared refresh settled.
              await reader.request(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, { sessionKeys: [] });
              await cue("Current reader received PR and CI results after identity reassignment");
              await screenshot("04-current-reader-after-reassignment.png");
              expect(current).toEqual({
                number: 203,
                repo: replacement.repo,
                branch: replacement.branch,
                additions: 5,
              });
              expect(isGatewayProtocolResponseError(rejectedChecks)).toBe(true);
              expect(rejectedChecks).toMatchObject({
                code: "UNAVAILABLE",
                message: "Session changed; reopen CI details",
              });
              expect(retiredDeliveries).toHaveLength(beforeIdentityReassignment);
              expect(checkResponses.at(-1)).toMatchObject({
                ok: true,
                number: 203,
                repo: replacement.repo,
                status: "ready",
                checks: [replacement.checkName],
              });
            } finally {
              if (artifacts) {
                await writeFile(
                  path.join(artifacts, "gateway-results.json"),
                  JSON.stringify(
                    {
                      delivered,
                      retiredDeliveries,
                      retiredCount,
                      checkResponses,
                      identityReassigned,
                      beforeIdentityReassignment,
                      retiringCheckResponses,
                    },
                    null,
                    2,
                  ),
                  { mode: 0o600 },
                );
              }
            }
          },
          async () => {
            releaseProvider.resolve();
            releaseIdentityReads.resolve();
          },
        );
      },
      async close() {
        releaseProvider.resolve();
        releaseIdentityReads.resolve();
        await runQaGatewayFixture(
          async () => {
            await retiringReader?.stopAndWait();
          },
          () => proxy?.close(),
          () => gateway?.close({ reason: "session PR reader proof cleanup" }),
          () => restoreFetch?.(),
        );
      },
      release: async () => {
        await state?.cleanup();
      },
    });
  });
});
