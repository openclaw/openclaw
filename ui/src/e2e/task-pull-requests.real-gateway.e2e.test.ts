import { execFile } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { withTimeout } from "@openclaw/fs-safe/advanced";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ViteDevServer } from "vite";
import { expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../../src/config/sessions/session-accessor.ts";
import { GatewayClient } from "../../../src/gateway/client.ts";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.ts";
import { insertRepositoryGitHubPublicationFixture } from "../../../src/gateway/github-publication-store.test-support.ts";
import { repositoryGitHubPublicationDigest } from "../../../src/gateway/github-repository-publication.kernel.ts";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { racePromiseWithAbortSignal } from "../../../src/infra/abort-signal.ts";
import { loadOrCreateDeviceIdentity } from "../../../src/infra/device-identity.ts";
import { getWorkerComputeCapacity } from "../../../src/infra/worker-task-capacity.ts";
import { createDeferredCore } from "../../../src/shared/deferred.ts";
import { publicationRowDefaults } from "../../../src/state/github-publication-fixtures.test-support.ts";
import type { RepositoryGitHubPublicationRow } from "../../../src/state/github-publication-read.types.ts";
import { setUserProfileRole } from "../../../src/state/user-profile-writes.worker.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { cleanupSessionStateForTest } from "../../../src/test-utils/session-state-cleanup.ts";
import { acquireGatewayTestClient } from "../../../test/helpers/gateway-client.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { recordControlUiE2eFailureFacts } from "../test-helpers/control-ui-e2e-diagnostics.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { deviceGatewayEnv } from "./device-gateway-env.test-support.ts";
import { createGatewayProxy, gatewayProxyRoute } from "./gateway-proxy.test-support.ts";
import { recordTaskPrDiagnostics } from "./task-pull-requests.diagnostics.test-support.ts";

const parentKey = "agent:main:task-pr-parent";
const selectedKey = "agent:main:release-planning";
const viewerEmail = "task-pr-viewer@example.test";
const numbers = [176407, 176403, 176410];
const repository = "openclaw/openclaw";
const branch = "proof/coordination-no-published-pr";
const execFileAsync = promisify(execFile);
const live = process.env.OPENCLAW_TASK_PR_LIVE_GITHUB === "1";
const foregroundReadinessTimeoutMs = 30_000;
const suite = createControlUiE2eSuite({
  name: "Delegated task PRs through a real Gateway",
  startServerBeforeBrowser: true,
});

async function seedTask(state: OpenClawTestState, profileId: string) {
  const createdActor = { type: "human", source: "profile", id: profileId } as const;
  replaceSessionEntrySync(
    { agentId: "main", sessionKey: selectedKey },
    {
      sessionId: "00000000-0000-4000-8000-000000000099",
      label: "Release planning",
      updatedAt: Date.now(),
      createdActor,
    },
  );
  const root = state.path("coordination");
  await mkdir(root, { recursive: true });
  const git = (...args: string[]) => execFileAsync("git", args, { cwd: root, env: state.env });
  await git("init", "--initial-branch=main");
  await writeFile(path.join(root, "README.md"), "# Synthetic task coordination\n");
  await git("add", "README.md");
  await git(
    "-c",
    "user.name=Task Proof",
    "-c",
    "user.email=proof@example.test",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-m",
    "test: seed isolated task",
  );
  await git("remote", "add", "origin", "https://github.com/" + repository + ".git");
  await git("update-ref", "refs/remotes/origin/main", "HEAD");
  await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  await git("checkout", "-b", branch);
  await writeFile(
    path.join(root, "README.md"),
    "# Synthetic task coordination\nUnpublished parent change.\n",
  );
  await git("add", "README.md");
  await git(
    "-c",
    "user.name=Task Proof",
    "-c",
    "user.email=proof@example.test",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-m",
    "test: unpublished parent work",
  );
  // Only a local tracking ref: model an already pushed branch, never push to GitHub.
  await git("update-ref", "refs/remotes/origin/" + branch, "HEAD");
  replaceSessionEntrySync(
    { agentId: "main", sessionKey: parentKey },
    {
      sessionId: "00000000-0000-4000-8000-000000000100",
      label: "Recovery improvements",
      createdActor,
      updatedAt: Date.now(),
      spawnedCwd: root,
      worktree: { id: "task-pr-parent-checkout", branch, repoRoot: root },
    },
  );
  for (const [index, number] of numbers.entries()) {
    const key = "agent:main:subagent:task-pr-child-" + index;
    const sessionId = "00000000-0000-4000-8000-00000000010" + (index + 1);
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      {
        sessionId,
        parentSessionKey: parentKey,
        createdActor,
        label: "Delegated repair " + (index + 1),
        updatedAt: Date.now(),
      },
    );
    const id = "task-pr-receipt-" + number;
    const row: RepositoryGitHubPublicationRow = {
      ...publicationRowDefaults(id),
      session_key: key,
      session_id: sessionId,
      session_lifecycle_revision: null,
      requester_authority_json: null,
      workspace_id: "workspace-" + id,
      owner_profile_id: null,
      connection_generation: null,
      identity_source: "system-configured",
      identity_profile_id: "fixture-profile",
      previous_head_commit: null,
      pushed_head_commit: null,
      claim_id: null,
      run_id: null,
      environment_id: null,
      owner_epoch: null,
      placement_generation: null,
      checkpoint_ref: null,
      checkpoint_digest: null,
      status: "published",
      repository,
      push_repository: repository,
      branch: "proof/repair-" + index,
      title: "Delegated repair " + (index + 1),
      pull_request_url: "https://github.com/" + repository + "/pull/" + number,
      created_at_ms: 1000 + index,
      updated_at_ms: 1000 + index,
    };
    row.request_digest = repositoryGitHubPublicationDigest(row);
    // Seed the canonical publication transaction before the Gateway takes custody.
    insertRepositoryGitHubPublicationFixture(row, () => {});
  }
}

suite.define(() => {
  it("shows three persisted descendant PRs while keeping the parent branch unpublished", async (test) => {
    let state: OpenClawTestState | undefined;
    let gateway: GatewayServer | undefined;
    let proxy: ViteDevServer | undefined;
    let restoreFetch: (() => void) | undefined;
    const gitOperations = [
      ["checkout.context", "Context"],
      ["checkout.revision", "Revision"],
      ["pull-request.branch-comparison", "Comparison"],
      ["pull-request.branch-facts", "BranchFacts"],
    ].map(([type, label]) => ({ type, label, count: 0, errors: 0, elapsedMs: 0 }));
    const gitOperationChannel = channel("openclaw.git.operation");
    const recordGitOperation = (message: unknown) => {
      if (!isRecord(message) || typeof message.operation !== "string") {
        return;
      }
      const operation = gitOperations.find((entry) => entry.type === message.operation);
      if (!operation || typeof message.elapsedMs !== "number") {
        return;
      }
      operation.count++;
      operation.errors += Number(message.outcome === "error");
      operation.elapsedMs += message.elapsedMs;
    };
    gitOperationChannel.subscribe(recordGitOperation);
    test.onTestFinished(() => gitOperationChannel.unsubscribe(recordGitOperation));
    const diagnostics = recordTaskPrDiagnostics([
      parentKey,
      ...numbers.map((_, index) => "agent:main:subagent:task-pr-child-" + index),
    ]);
    test.onTestFinished(diagnostics.stop);
    await suite.runScenario(test, {
      retainedState: () => state?.root,
      async run() {
        state = await createOpenClawTestState({
          label: "task-pr-live",
          layout: "home",
          env: {
            GH_TOKEN: undefined,
            GITHUB_TOKEN: undefined,
            OPENCLAW_GATEWAY_PASSWORD: undefined,
            OPENCLAW_GATEWAY_TOKEN: undefined,
            ...deviceGatewayEnv,
          },
        });
        const port = await getFreePort();
        const viewer = ensureProfileForEmail(viewerEmail);
        setUserProfileRole(viewer.id, "reader");
        const trustedProxy = {
          allowLoopback: true,
          allowUsers: [viewerEmail],
          deviceAutoApprove: { enabled: true, scopes: ["operator.read"] },
          requiredHeaders: ["x-forwarded-proto"],
          userHeader: "x-forwarded-user",
        };
        await state.writeConfig({
          agents: {
            defaults: { workspace: state.workspaceDir, model: { primary: "openai/gpt-4.1" } },
            entries: { main: {} },
          },
          gateway: {
            port,
            trustedProxies: ["127.0.0.1", "::1"],
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
            auth: { mode: "trusted-proxy", trustedProxy },
            controlUi: { enabled: false, allowedOrigins: [new URL(suite.server.baseUrl).origin] },
          },
        });
        await seedTask(state, viewer.id);
        const githubRequests: string[] = [];
        {
          const realFetch = globalThis.fetch;
          const transport = vi
            .spyOn(globalThis, "fetch")
            .mockImplementation(async (input, init) => {
              const url = new URL(
                typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
              );
              if (url.hostname !== "api.github.com") {
                return realFetch(input, init);
              }
              githubRequests.push(url.pathname + url.search);
              if (live) {
                return realFetch(input, init);
              }
              if (url.pathname === "/repos/" + repository) {
                return Response.json({ fork: false, default_branch: "main" });
              }
              if (url.pathname.endsWith("/check-runs")) {
                return Response.json({ total_count: 0, check_runs: [] });
              }
              const number = Number(url.pathname.split("/").at(-1));
              if (
                url.pathname === "/repos/" + repository + "/pulls" &&
                url.searchParams.get("head") === "openclaw:" + branch
              ) {
                return Response.json([]);
              }
              if (!numbers.includes(number)) {
                throw new Error("Unexpected GitHub request: " + url.href);
              }
              return Response.json({
                number,
                title: "Delegated repair " + (numbers.indexOf(number) + 1),
                html_url: "https://github.com/" + repository + "/pull/" + number,
                state: "open",
                draft: false,
                merged_at: null,
                head: { ref: "proof/repair-" + numbers.indexOf(number), sha: "a".repeat(40) },
                base: { ref: "main", repo: { name: "openclaw", owner: { login: "openclaw" } } },
                additions: 12,
                deletions: 3,
                changed_files: 2,
              });
            });
          restoreFetch = () => transport.mockRestore();
        }
        const { startGatewayServer } = await import("../../../src/gateway/server.js");
        const start = () =>
          startGatewayServer(port, {
            auth: { mode: "trusted-proxy", trustedProxy },
            bind: "loopback",
            controlUiEnabled: false,
            sidecarStartup: "defer",
          });
        gateway = await start();
        proxy = await createGatewayProxy(state.workspaceDir, {
          "/": gatewayProxyRoute(port, viewerEmail),
        });
        await proxy.listen();
        const proxyUrl = proxy.resolvedUrls?.local[0];
        if (!proxyUrl) {
          throw new Error("Task PR fixture proxy has no loopback URL");
        }
        const browserGatewayUrl = new URL(proxyUrl);
        browserGatewayUrl.protocol = "ws:";
        // Browser WebSocket traffic is never replaced: only external GitHub HTTP is fixture-backed.
        for (const stage of ["initial", "restarted"] as const) {
          const stageStartedAt = performance.now();
          diagnostics.beginStage();
          for (const operation of gitOperations) {
            operation.count = operation.errors = operation.elapsedMs = 0;
          }
          const requestsBeforeStage = githubRequests.length;
          await suite.withPage(
            {
              viewport: { width: 1280, height: 900 },
              colorScheme: "dark",
              locale: "en-US",
              serviceWorkers: "block",
            },
            async ({ page }) => {
              await page.addInitScript(() => {
                localStorage.setItem("openclaw:sidebar:sessions:collapsed-sections", "[]");
                localStorage.setItem(
                  "openclaw:control-ui:community-invite:v2",
                  JSON.stringify({ dismissedAtMs: 1770000000000 }),
                );
              });
              const snapshots: Record<string, unknown>[] = [];
              type Subscription = {
                foreground: boolean;
                passive: boolean;
                acknowledged: boolean | null;
              };
              let latestSubscription: Subscription | undefined;
              let foregroundEver = false;
              let foregroundAcknowledged = false;
              let foregroundRejected = false;
              page.on("websocket", (socket) => {
                const trace = diagnostics.socket();
                socket.on("close", trace.close);
                const pending = new Map<string, Subscription>();
                socket.on("framesent", ({ payload }) => {
                  const frame: unknown = JSON.parse(String(payload));
                  trace.sent(frame);
                  if (
                    !isRecord(frame) ||
                    frame.type !== "req" ||
                    frame.method !== "controlUi.sessionPullRequests.subscribe" ||
                    typeof frame.id !== "string" ||
                    !isRecord(frame.params)
                  ) {
                    return;
                  }
                  const subscription: Subscription = {
                    foreground:
                      Array.isArray(frame.params.sessionKeys) &&
                      frame.params.sessionKeys.includes(parentKey),
                    passive:
                      Array.isArray(frame.params.passiveSessionKeys) &&
                      frame.params.passiveSessionKeys.includes(parentKey),
                    acknowledged: null,
                  };
                  pending.set(frame.id, subscription);
                  latestSubscription = subscription;
                  foregroundEver ||= subscription.foreground;
                });
                socket.on("framereceived", ({ payload }) => {
                  const frame: unknown = JSON.parse(String(payload));
                  trace.received(frame);
                  if (isRecord(frame) && frame.type === "res" && typeof frame.id === "string") {
                    const subscription = pending.get(frame.id);
                    if (subscription) {
                      subscription.acknowledged = frame.ok === true;
                      foregroundAcknowledged ||=
                        subscription.foreground && subscription.acknowledged;
                      foregroundRejected ||= subscription.foreground && !subscription.acknowledged;
                      pending.delete(frame.id);
                    }
                  }
                  if (
                    !isRecord(frame) ||
                    frame.event !== CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT ||
                    !isRecord(frame.payload) ||
                    !isRecord(frame.payload.sessions)
                  ) {
                    return;
                  }
                  const snapshot = frame.payload.sessions[parentKey];
                  if (isRecord(snapshot)) {
                    snapshots.push(snapshot);
                  }
                });
              });
              const url = new URL(controlUiSessionUrl(suite.server.baseUrl, selectedKey));
              url.hash = new URLSearchParams({ gatewayUrl: browserGatewayUrl.href }).toString();
              await page.goto(url.href);
              await page
                .locator("openclaw-gateway-url-confirmation")
                .getByRole("button", { name: "Switch to " + browserGatewayUrl.host, exact: true })
                .click();
              await waitForControlUiRoute(page, { routeId: "chat" });
              const row = page.locator(
                '.sidebar-recent-session[data-session-key="' + parentKey + '"]',
              );
              await row.waitFor();
              const card = page.locator(".session-progress-hovercard");
              let activated = false;
              const activate = async () => {
                if (activated) {
                  return;
                }
                await row.locator(".sidebar-recent-session__link").focus();
                await card.waitFor({ timeout: foregroundReadinessTimeoutMs });
                // The earlier passive receipt snapshot is already ready.
                await expect
                  .poll(() => latestSubscription)
                  .toMatchObject({
                    foreground: true,
                    passive: false,
                    acknowledged: true,
                  });
                activated = true;
              };
              try {
                // The selected session has no worktree: a parent hover must not be needed to hydrate its badge.
                await expect
                  .poll(() => row.locator(".session-row-badge--pull-request").isVisible())
                  .toBe(true);
                await expect.poll(() => snapshots.at(-1)?.taskPullRequestCount).toBe(3);
                expect(githubRequests.length).toBe(requestsBeforeStage);
                await activate();
                await expect.poll(() => snapshots.at(-1)?.taskPullRequestCount).toBe(3);
                await expect
                  .poll(() => snapshots.at(-1)?.taskPullRequests, {
                    timeout: foregroundReadinessTimeoutMs,
                  })
                  .toEqual(
                    expect.arrayContaining(
                      numbers.map((number, index) =>
                        expect.objectContaining({
                          number,
                          sourceSessionKey: "agent:main:subagent:task-pr-child-" + index,
                          sourceAgentId: "main",
                          pullRequest: expect.objectContaining({
                            number,
                            title: expect.any(String),
                          }),
                        }),
                      ),
                    ),
                  );
                expect(snapshots.at(-1)?.pullRequests).toEqual([]);
                expect(snapshots.at(-1)?.branch).toMatchObject({ branch });
                await expect.poll(() => card.locator(".session-hovercard__pr-row").count()).toBe(3);
                await expect
                  .poll(() => row.locator(".session-row-badge--pull-request").count())
                  .toBe(1);
                for (const number of numbers) {
                  expect(
                    await card
                      .locator(
                        'a[href="https://github.com/' + repository + "/pull/" + number + '"]',
                      )
                      .count(),
                  ).toBe(1);
                }
              } catch (error) {
                diagnostics.capture(page, stage);
                const hydratedCount = (snapshot: Record<string, unknown> | undefined) =>
                  Array.isArray(snapshot?.taskPullRequests)
                    ? snapshot.taskPullRequests.filter(
                        (item: unknown) => isRecord(item) && isRecord(item.pullRequest),
                      ).length
                    : 0;
                const latestSnapshot = snapshots.at(-1);
                const workerCompute = getWorkerComputeCapacity().getSnapshot();
                recordControlUiE2eFailureFacts(page, {
                  taskPrStageElapsedMs: performance.now() - stageStartedAt,
                  ...Object.fromEntries(
                    gitOperations.flatMap((operation) => [
                      [`taskPrGit${operation.label}Completed`, operation.count],
                      [`taskPrGit${operation.label}Errors`, operation.errors],
                      [`taskPrGit${operation.label}ElapsedMs`, operation.elapsedMs],
                    ]),
                  ),
                  taskPrWorkerComputeLimit: workerCompute.limit,
                  taskPrWorkerComputeActive: workerCompute.active,
                  taskPrWorkerComputeWaitingPools: workerCompute.waitingPools,
                  taskPrWorkerComputePendingTasks: workerCompute.pendingTasks,
                  taskPrWorkerComputePendingBytes: workerCompute.pendingBytes,
                  taskPrSnapshotCount: snapshots.length,
                  taskPrLatestReceiptCount: Array.isArray(latestSnapshot?.taskPullRequests)
                    ? latestSnapshot.taskPullRequests.length
                    : 0,
                  taskPrLatestHydratedCount: hydratedCount(latestSnapshot),
                  taskPrMaxHydratedCount: Math.max(0, ...snapshots.map(hydratedCount)),
                  taskPrLatestReceiptOnly: latestSnapshot?.branchRead === false,
                  taskPrLatestUnavailable: latestSnapshot?.status === "unavailable",
                  taskPrForegroundEver: foregroundEver,
                  taskPrForegroundAcknowledged: foregroundAcknowledged,
                  taskPrForegroundRejected: foregroundRejected,
                  taskPrLatestForeground: latestSubscription?.foreground ?? null,
                  taskPrLatestPassive: latestSubscription?.passive ?? null,
                  taskPrLatestAcknowledged: latestSubscription?.acknowledged ?? null,
                  taskPrGithubRequestCount: githubRequests.length - requestsBeforeStage,
                });
                await withTimeout(
                  page.evaluate((key) => {
                    const diagnosticRow = document.querySelector(
                      '.sidebar-recent-session[data-session-key="' + key + '"]',
                    );
                    const trigger = diagnosticRow?.querySelector(".sidebar-recent-session__link");
                    const diagnosticCard = document.querySelector(".session-progress-hovercard");
                    return {
                      taskPrDocumentHidden: document.hidden,
                      taskPrTriggerPresent: Boolean(trigger),
                      taskPrTriggerFocused: Boolean(trigger && document.activeElement === trigger),
                      taskPrCardPresent: Boolean(diagnosticCard),
                      taskPrCardVisible:
                        diagnosticCard?.checkVisibility({ visibilityProperty: true }) ?? false,
                      taskPrCardRowCount:
                        diagnosticCard?.querySelectorAll(".session-hovercard__pr-row").length ?? 0,
                    };
                  }, parentKey),
                  1_000,
                )
                  .then((facts) => recordControlUiE2eFailureFacts(page, facts))
                  .catch(() => undefined);
                throw error;
              } finally {
                // On red, show the same parent hovercard rather than a transient loading shell.
                await activate();
                if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
                  const frame = await takeControlUiScreenshotFrame(
                    page,
                    card,
                    [card.locator(".session-hovercard__title")],
                    { animations: "disabled", elements: [row] },
                  );
                  await writeFile(path.join(suite.artifactDir, stage + ".png"), frame.png);
                }
                await writeFile(
                  path.join(suite.artifactDir, stage + "-snapshots.json"),
                  JSON.stringify({ live, snapshots, githubRequests }, null, 2),
                );
              }
            },
          );
          if (stage === "initial") {
            await gateway.close({ reason: "task PR persistence proof restart" });
            // Reopen persisted rows, not this process's retained projection/database handles.
            await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
            gateway = await start();
          }
        }
      },
      close: () =>
        runQaGatewayFixture(
          async () => {
            await proxy?.close();
          },
          async () => {
            await gateway?.close({ reason: "task PR proof cleanup" });
          },
          () => restoreFetch?.(),
        ),
      release: async () => state?.cleanup(),
    });
  });

  it("enforces viewer receipt scope, descendant privacy, and grant revocation at the socket", async (test) => {
    let state: OpenClawTestState | undefined;
    let gateway: GatewayServer | undefined;
    let proxy: ViteDevServer | undefined;
    let restoreFetch: (() => void) | undefined;
    const clients: GatewayClient[] = [];
    const providerEntered = createDeferredCore();
    const releaseProvider = createDeferredCore();
    const root = "agent:main:task-authority-root";
    const child = "agent:main:task-authority-child";
    const pendingRoot = "agent:main:task-authority-pending";
    const firstChild = "agent:main:task-authority-first";
    const lastChild = "agent:main:task-authority-last";
    const repo = "synthetic/authority-proof";
    type WireEvent = { event: string; payload?: unknown };
    const snapshots = (events: WireEvent[], key: string) =>
      events.flatMap((event) => {
        if (
          event.event !== CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT ||
          !isRecord(event.payload) ||
          !isRecord(event.payload.sessions)
        ) {
          return [];
        }
        const snapshot = event.payload.sessions[key];
        return isRecord(snapshot) ? [snapshot] : [];
      });
    const numbersIn = (snapshot: Record<string, unknown> | undefined) =>
      (Array.isArray(snapshot?.taskPullRequests) ? snapshot.taskPullRequests : [])
        .flatMap((item: unknown) =>
          isRecord(item) && typeof item.number === "number" ? [item.number] : [],
        )
        .toSorted((left, right) => left - right);
    const enriched = (snapshot: Record<string, unknown> | undefined) =>
      Array.isArray(snapshot?.taskPullRequests) &&
      snapshot.taskPullRequests.length > 0 &&
      snapshot.taskPullRequests.every(
        (item: unknown) => isRecord(item) && isRecord(item.pullRequest),
      );
    const calls: Array<{ number: number; phase: string }> = [];
    let phase = "visible";
    await suite.runScenario(test, {
      retainedState: () => state?.root,
      async run(signal) {
        state = await createOpenClawTestState({
          label: "task-pr-authority",
          layout: "home",
          env: {
            GH_TOKEN: undefined,
            GITHUB_TOKEN: undefined,
            OPENCLAW_GATEWAY_PASSWORD: undefined,
            OPENCLAW_GATEWAY_TOKEN: undefined,
            ...deviceGatewayEnv,
          },
        });
        const ownerEmail = "task-authority-owner@example.test";
        const aEmail = "task-authority-a@example.test";
        const bEmail = "task-authority-b@example.test";
        const owner = ensureProfileForEmail(ownerEmail);
        const a = ensureProfileForEmail(aEmail);
        const b = ensureProfileForEmail(bEmail);
        setUserProfileRole(owner.id, "admin");
        for (const profile of [a, b]) {
          setUserProfileRole(profile.id, "reader");
        }
        const ownerActor = { type: "human", source: "profile", id: owner.id } as const;
        for (const [key, parent] of [
          [root],
          [child, root],
          [pendingRoot],
          [firstChild, pendingRoot],
          [lastChild, pendingRoot],
        ] as const) {
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: key },
            {
              sessionId: key + "-id",
              updatedAt: Date.now(),
              createdActor: ownerActor,
              visibility: "shared",
              ...(parent ? { parentSessionKey: parent } : {}),
            },
          );
        }
        const receipt = (key: string, number: number, time: number, personalOwner?: string) => {
          const id = "authority-receipt-" + number;
          const row: RepositoryGitHubPublicationRow = {
            ...publicationRowDefaults(id),
            session_key: key,
            session_id: key + "-id",
            session_lifecycle_revision: null,
            requester_authority_json: null,
            workspace_id: "workspace-" + id,
            owner_profile_id: personalOwner ?? null,
            connection_generation: personalOwner ? "synthetic-personal-generation" : null,
            identity_source: personalOwner ? "personal" : "system-configured",
            identity_profile_id: personalOwner ?? "fixture-profile",
            previous_head_commit: null,
            pushed_head_commit: null,
            claim_id: null,
            run_id: null,
            environment_id: null,
            owner_epoch: null,
            placement_generation: null,
            checkpoint_ref: null,
            checkpoint_digest: null,
            status: "published",
            repository: repo,
            push_repository: repo,
            branch: "proof/" + number,
            title: "Authority receipt " + number,
            pull_request_url: "https://github.com/" + repo + "/pull/" + number,
            created_at_ms: time,
            updated_at_ms: time,
          };
          row.request_digest = repositoryGitHubPublicationDigest(row);
          insertRepositoryGitHubPublicationFixture(row, () => {});
        };
        receipt(child, 1111, 6000);
        receipt(root, 1112, 5000, a.id);
        receipt(root, 1113, 4000, b.id);
        // The shared read stalls before A's personal endpoint; B cannot authorize that endpoint.
        receipt(firstChild, 1121, 6000);
        receipt(pendingRoot, 1122, 5000, a.id);
        receipt(lastChild, 1123, 4000);
        const port = await getFreePort();
        const origin = "http://127.0.0.1:" + port;
        const trustedProxy = {
          allowLoopback: true,
          allowUsers: [ownerEmail, aEmail, bEmail],
          deviceAutoApprove: { enabled: true, scopes: ["operator.read", "operator.admin"] },
          requiredHeaders: ["x-forwarded-proto"],
          userHeader: "x-forwarded-user",
        };
        await state.writeConfig({
          agents: {
            defaults: { workspace: state.workspaceDir, model: { primary: "openai/gpt-4.1" } },
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
                blocked: {
                  agents: ["main"],
                  sessions: { others: "none" },
                  scopes: [],
                },
                admin: {
                  agents: ["main"],
                  sessions: { others: "write" },
                  scopes: ["operator.admin"],
                },
              },
            },
          },
        });
        const realFetch = globalThis.fetch;
        const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
          const url = new URL(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          );
          if (url.hostname !== "api.github.com") {
            return realFetch(input, init);
          }
          const number = Number(url.pathname.split("/").at(-1));
          if (
            !url.pathname.startsWith("/repos/" + repo + "/pulls/") ||
            ![1111, 1112, 1113, 1121, 1122, 1123].includes(number)
          ) {
            throw new Error("Unexpected authority fixture GitHub request: " + url.pathname);
          }
          calls.push({ number, phase });
          if (number === 1121) {
            providerEntered.resolve();
            await racePromiseWithAbortSignal(releaseProvider.promise, signal);
          }
          return Response.json({
            number,
            title: "Authority receipt " + number,
            html_url: "https://github.com/" + repo + "/pull/" + number,
            state: "closed",
            draft: false,
            merged_at: null,
            head: { ref: "proof/" + number, sha: "a".repeat(40) },
            base: { ref: "main", repo: { name: "authority-proof", owner: { login: "synthetic" } } },
          });
        });
        restoreFetch = () => provider.mockRestore();
        const { startGatewayServer } = await import("../../../src/gateway/server.js");
        gateway = await startGatewayServer(port, {
          auth: { mode: "trusted-proxy", trustedProxy },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        const route = (email: string) => ({
          ...gatewayProxyRoute(port, email),
          rewrite: () => "/",
        });
        proxy = await createGatewayProxy(state.workspaceDir, {
          "/owner": route(ownerEmail),
          "/a": route(aEmail),
          "/b": route(bEmail),
        });
        await proxy.listen();
        const address = proxy.resolvedUrls?.local[0];
        if (!address) {
          throw new Error("Authority fixture proxy has no loopback URL");
        }
        const fixtureState = state;
        const connect = async (name: string, admin = false) => {
          const events: WireEvent[] = [];
          const closed = createDeferredCore<number>();
          const url = new URL(name, address);
          url.protocol = "ws:";
          const client = await acquireGatewayTestClient(
            {
              url: url.href,
              origin,
              clientName: "openclaw-control-ui",
              mode: "webchat",
              role: "operator",
              scopes: [admin ? "operator.admin" : "operator.read"],
              sharedStateMode: "read-only",
              deviceIdentity: loadOrCreateDeviceIdentity({
                env: fixtureState.env,
                identityKey: "task-authority-" + name,
              }),
              onHelloOk: (hello) =>
                expect(hello.auth?.scopes).toEqual([admin ? "operator.admin" : "operator.read"]),
              onEvent: (event) => events.push(event),
              onClose: (code) => closed.resolve(code),
            },
            {
              signal,
              timeoutMs: 15_000,
              timeoutMessage: "Authority reader did not connect",
              closeMessage: "Authority reader closed before hello",
            },
          );
          clients.push(client);
          return {
            client,
            events,
            closed: closed.promise,
            latest: (key: string) => snapshots(events, key).at(-1),
          };
        };
        const admin = await connect("owner", true);
        const readerA = await connect("a");
        const readerB = await connect("b");
        const subscribe = (reader: typeof readerA, key: string, passive: boolean) =>
          reader.client.request("controlUi.sessionPullRequests.subscribe", {
            sessionKeys: passive ? [] : [key],
            ...(passive ? { passiveSessionKeys: [key] } : {}),
          });
        await subscribe(readerA, root, true);
        await subscribe(readerB, root, true);
        await expect.poll(() => numbersIn(readerA.latest(root))).toEqual([1111, 1112]);
        await expect.poll(() => numbersIn(readerB.latest(root))).toEqual([1111, 1113]);
        expect(calls).toEqual([]);
        await subscribe(readerA, root, false);
        await expect.poll(() => enriched(readerA.latest(root))).toBe(true);
        expect(calls.map((call) => call.number).toSorted((left, right) => left - right)).toEqual([
          1111, 1112,
        ]);
        await subscribe(readerB, root, false);
        await expect.poll(() => enriched(readerB.latest(root))).toBe(true);
        expect(numbersIn(readerA.latest(root))).toEqual([1111, 1112]);
        expect(numbersIn(readerB.latest(root))).toEqual([1111, 1113]);
        expect(JSON.stringify(readerA.events)).not.toContain("/pull/1113");
        expect(JSON.stringify(readerB.events)).not.toContain("/pull/1112");

        // This is a real committed sharing RPC, not an invalidation mocked into a helper.
        await admin.client.request("session.visibility.set", {
          sessionKey: child,
          visibility: "draft",
        });
        await expect.poll(() => numbersIn(readerA.latest(root))).toEqual([1112]);
        await expect.poll(() => numbersIn(readerB.latest(root))).toEqual([1113]);
        await expect(
          readerA.client.request("session.members.list", { sessionKey: child }),
        ).rejects.toMatchObject({
          code: "INVALID_REQUEST",
          details: { code: "SESSION_SHARING_MANAGER_REQUIRED" },
        });

        const aBeforePending = readerA.events.length;
        phase = "pending";
        await subscribe(readerA, pendingRoot, false);
        await racePromiseWithAbortSignal(providerEntered.promise, signal);
        await subscribe(readerB, pendingRoot, false);
        expect(calls.some((call) => call.number === 1122)).toBe(false);
        const revoked = await admin.client.request<{ profile: { role: string } }>("users.setRole", {
          profileId: a.id,
          role: "blocked",
        });
        expect(revoked.profile.role).toBe("blocked");
        const closedCode = await racePromiseWithAbortSignal(readerA.closed, signal);
        phase = "revoked";
        releaseProvider.resolve();
        // B remains authorized and drains the held shared read through a real socket delivery.
        await expect.poll(() => enriched(readerB.latest(pendingRoot))).toBe(true);
        expect(numbersIn(readerB.latest(pendingRoot))).toEqual([1121, 1123]);
        expect(snapshots(readerA.events.slice(aBeforePending), pendingRoot)).toEqual([]);
        expect(calls.some((call) => call.number === 1122)).toBe(false);
        expect(JSON.stringify(readerB.events)).not.toContain("/pull/1122");
        await writeFile(
          path.join(suite.artifactDir, "authority-rejection.json"),
          JSON.stringify(
            {
              calls,
              readerA: readerA.events.filter(
                (event) => event.event === CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
              ),
              readerB: readerB.events.filter(
                (event) => event.event === CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
              ),
              grantRejection: { role: revoked.profile.role, closedCode },
            },
            null,
            2,
          ),
        );
      },
      async close() {
        releaseProvider.resolve();
        await runQaGatewayFixture(
          async () => {
            await Promise.all(clients.map((client) => client.stopAndWait()));
          },
          () => proxy?.close(),
          () => gateway?.close({ reason: "task authority proof cleanup" }),
          () => restoreFetch?.(),
        );
      },
      release: async () => state?.cleanup(),
    });
  });
});
