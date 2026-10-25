import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import type { ViteDevServer } from "vite";
import { expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../../src/config/sessions/session-accessor.ts";
import { GatewayClient, isGatewayProtocolResponseError } from "../../../src/gateway/client.ts";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.ts";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { racePromiseWithAbortSignal } from "../../../src/infra/abort-signal.ts";
import { loadOrCreateDeviceIdentity } from "../../../src/infra/device-identity.ts";
import { createDeferredCore } from "../../../src/shared/deferred.ts";
import { readResidentUserProfileId } from "../../../src/state/user-profile-list.ts";
import { linkEmail, setUserProfileRole } from "../../../src/state/user-profile-writes.worker.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import {
  openDesktopPullRequestPage,
  openDetailsPullRequests,
} from "./chat-details.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createGatewayProxy, gatewayProxyRoute } from "./gateway-proxy.test-support.ts";

const sessionKey = "agent:main:pr-reader-lifetime";
const checksMethod = "controlUi.sessionPullRequests.checks";
const viewerEmail = "pr-viewer@example.test";
const retiringEmail = "retiring-pr-reader@example.test";
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
  title?: string;
  checkName?: string;
};
type Delivery = { number: number; repo: string; branch: string; additions?: number };
function expectedDelivery({ number, repo, branch, additions }: Repository): Delivery {
  return { number, repo, branch, additions };
}

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
    title: repository.title ?? `Review ${repository.repo}`,
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

async function refreshFromBrowser(page: Page) {
  return evaluateControlUiContext(
    page,
    async (context, { method, sessionKey: requestedKey }) => {
      const client = context.gateway.snapshot.client;
      if (!client) {
        throw new Error("Control UI Gateway client is unavailable");
      }
      await client.request(method, {
        sessionKeys: [requestedKey],
        refreshSessionKeys: [requestedKey],
      });
      return context.gateway.snapshot.hello?.auth?.scopes;
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
    const releaseReads = async () => {
      releaseProvider.resolve();
      releaseIdentityReads.resolve();
    };
    await suite.runScenario(test, {
      retainedState: () => state?.root,
      async run(signal) {
        const waitFor = <T>(deferred: { promise: Promise<T> }) =>
          racePromiseWithAbortSignal(deferred.promise, signal);
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
        for (const profile of [viewer, retiring]) {
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
            return json(pullRequest(repository));
          }
          if (url.pathname.endsWith("/check-runs")) {
            // CI details read the admitted commit without fetching the mutable PR again.
            if (repository === replacement && holdChecks) {
              holdChecks = false;
              checksEntered.resolve();
              await releaseIdentityReads.promise;
            }
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
        // Chromium does not consistently apply extraHTTPHeaders to WebSocket upgrades.
        proxy = await createGatewayProxy(state.workspaceDir, {
          "/retiring": {
            ...gatewayProxyRoute(port, retiringEmail),
            rewrite: () => "/",
          },
          "/": gatewayProxyRoute(port, viewerEmail),
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
        expect(await waitFor(connected)).toEqual(["operator.read"]);
        const reader = retiringReader;
        const subscribe = (keys = [sessionKey], refresh = false) =>
          reader.request(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
            sessionKeys: keys,
            ...(refresh ? { refreshSessionKeys: keys } : {}),
          });
        await suite.withPage(
          {
            viewport: { width: 1180, height: 800 },
            colorScheme: "light",
            locale: "en-US",
            serviceWorkers: "block",
          },
          async ({ page }) => {
            await page.addInitScript(() =>
              localStorage.setItem(
                "openclaw:control-ui:community-invite:v2",
                JSON.stringify({ dismissedAtMs: 1770000000000 }),
              ),
            );
            const initialDelivery = createDeferredCore<Delivery>();
            const changedDelivery = createDeferredCore<Delivery>();
            const replacementSummaryDelivery = createDeferredCore<Delivery>();
            const currentReaderDelivery = createDeferredCore<Delivery>();
            const checkResponses: { ok: boolean; payload: unknown }[] = [];
            let waitingForReplacement = false;
            let identityReassigned = false;
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
                  checkResponses.push({ ok: frame.ok === true, payload: frame.payload });
                }
                const delivery =
                  frame.event === CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT
                    ? deliveryFrom(frame.payload)
                    : undefined;
                if (delivery) {
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
            expect(await waitFor(initialDelivery)).toEqual(expectedDelivery(original));
            const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
            await openDetailsPullRequests(pane);
            const chip = pane.locator(".chat-pr").first();
            const prLink = (repository: Repository) =>
              chip.getByRole("link", {
                name: `Pull request synthetic/${repository.repo}#${repository.number}: ${repository.title ?? `Review ${repository.repo}`}`,
                exact: true,
              });
            const refreshRoster = async () => {
              await evaluateControlUiContext(page, async (context) => {
                await context.sessions.refresh({ agentId: "main", force: true });
              });
              await expect
                .poll(() =>
                  pane
                    .locator(".chat-pane__workspace-chip")
                    .filter({ visible: true })
                    .getAttribute("aria-label"),
                )
                .toBe("Workspace actions for replacement-workspace");
            };
            await expect
              .poll(() => prLink(original).getAttribute("href"))
              .toBe(`https://github.com/synthetic/${original.repo}/pull/${original.number}`);
            await openDesktopPullRequestPage(chip, "checks");
            await pane.getByText("original-workspace check", { exact: true }).waitFor();
            await page.keyboard.press("Escape");
            await chip.locator('.chat-pr-menu [data-value="checks"]').waitFor();
            await page.keyboard.press("Escape");
            await chip.locator(".chat-pr-menu").waitFor({ state: "hidden" });
            await pane.locator('.chat-details[role="dialog"]').waitFor();
            await subscribe();
            await expect.poll(() => retiredDeliveries.length).toBe(1);

            // Change provider facts so settlement is observable even on the unfixed server.
            original.number = 102;
            holdOriginal = true;
            await subscribe([sessionKey], true);
            await waitFor(providerEntered);
            await subscribe([]);
            const retiredCount = retiredDeliveries.length;
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
            const settled = await waitFor(changedDelivery);
            // PR delivery does not reconcile the pane after the fixture's direct database write.
            await refreshRoster();
            // A new session incarnation resets the pane-local Details presentation.
            await openDetailsPullRequests(pane);
            await expect
              .poll(() => prLink(replacement).getAttribute("href"))
              .toBe(`https://github.com/synthetic/${settled.repo}/pull/${settled.number}`);
            expect(settled).toEqual(expectedDelivery(replacement));
            expect(retiredDeliveries).toHaveLength(retiredCount);
            expect(await chip.locator(".chat-pr__link").getAttribute("href")).toBe(
              `https://github.com/synthetic/${replacement.repo}/pull/${replacement.number}`,
            );
            await openDesktopPullRequestPage(chip, "checks");
            await pane.getByText("replacement-workspace check", { exact: true }).waitFor();

            await page.keyboard.press("Escape");
            await chip.locator('.chat-pr-menu [data-value="checks"]').waitFor();
            await page.keyboard.press("Escape");
            await chip.locator(".chat-pr-menu").waitFor({ state: "hidden" });
            // A new PR keeps the details request cold while the real summary is already known.
            replacement.number = 203;
            replacement.checkName = "replacement-workspace current-reader check";
            expect(await refreshFromBrowser(page)).toEqual(["operator.read"]);
            // The subscription acknowledgement precedes the owner's paced refresh.
            expect(await waitFor(replacementSummaryDelivery)).toEqual(
              expectedDelivery(replacement),
            );
            // A later roster read must not dismiss Details for the already adopted incarnation.
            await refreshRoster();
            await expect
              .poll(() => prLink(replacement).getAttribute("href"))
              .toBe(`https://github.com/synthetic/${replacement.repo}/pull/203`);
            await subscribe();
            await expect.poll(() => retiredDeliveries.at(-1)?.number).toBe(203);
            const beforeIdentityReassignment = retiredDeliveries.length;

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
                () => {
                  checksEntered.reject(
                    new Error("CI details succeeded before the held provider was entered"),
                  );
                },
                (error: unknown) => {
                  rejectedChecks = error;
                  checksEntered.reject(
                    new Error("CI details rejected before the held provider was entered", {
                      cause: error,
                    }),
                  );
                },
              );
            await waitFor(checksEntered);
            holdSnapshot = true;
            // Change a list-visible metadata field so the shared detail cache admits new facts.
            replacement.title = "Updated replacement workspace review";
            replacement.additions = 5;
            await subscribe([sessionKey], true);
            await waitFor(snapshotEntered).catch((cause: unknown) => {
              throw new Error("The held PR snapshot provider was not entered", { cause });
            });
            linkEmail(retiringEmail, viewer.id);
            identityReassigned = readResidentUserProfileId(retiring.id) === viewer.id;
            expect(identityReassigned).toBe(true);

            expect(await refreshFromBrowser(page)).toEqual(["operator.read"]);
            releaseIdentityReads.resolve();
            const current = await waitFor(currentReaderDelivery).catch((cause: unknown) => {
              throw new Error("The current reader did not receive PR #203 with additions=5", {
                cause,
              });
            });
            await pendingChecks;
            await openDesktopPullRequestPage(chip, "checks");
            await pane.getByText(replacement.checkName, { exact: true }).waitFor();
            // The response drains earlier frames on this socket after the shared refresh settled.
            await subscribe([]);
            expect(current).toEqual(expectedDelivery(replacement));
            expect(isGatewayProtocolResponseError(rejectedChecks)).toBe(true);
            expect(rejectedChecks).toMatchObject({
              code: "UNAVAILABLE",
              message: "Session changed; reopen CI details",
            });
            expect(retiredDeliveries).toHaveLength(beforeIdentityReassignment);
            expect(checkResponses.at(-1)).toMatchObject({
              ok: true,
              payload: {
                number: 203,
                repo: replacement.repo,
                status: "ready",
                checks: [{ name: replacement.checkName }],
              },
            });
          },
          releaseReads,
        );
      },
      async close() {
        await releaseReads();
        await runQaGatewayFixture(
          async () => retiringReader?.stopAndWait(),
          () => proxy?.close(),
          () => gateway?.close({ reason: "session PR reader proof cleanup" }),
          () => restoreFetch?.(),
        );
      },
      release: async () => state?.cleanup(),
    });
  });
});
