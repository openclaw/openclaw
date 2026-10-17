import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  ProjectRecord,
  ProjectsListResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { markdownGitHubAliases } from "../components/markdown-github-repositories.ts";
import { createApplicationGateway } from "../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { projectsForGateway } from "./projects.ts";

const project: ProjectRecord = {
  id: "registered",
  displayName: "ClawSweeper",
  repoRoot: "/workspace/project",
  source: "registered",
  originUrl: "https://github.com/openclaw/clawsweeper.git",
};

function harness() {
  const request = vi.fn(async (): Promise<ProjectsListResult> => ({ projects: [project] }));
  const snapshot: ApplicationGatewaySnapshot = {
    client: createTestGatewayClient(request),
    phase: "connected",
    offlineStable: false,
    hello: {
      type: "hello-ok",
      protocol: 1,
      features: { methods: ["projects.list"] },
      auth: {
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        recoveryScope: "principal-a",
      },
    },
    sessionKey: "agent:main:first",
    assistantAgentId: "main",
    canvasPluginSurfaceUrl: null,
    lastError: null,
    lastErrorCode: null,
  };
  const { gateway, publish, publishEvent } = createApplicationGateway(snapshot);
  const subscribe = gateway.subscribe.bind(gateway);
  const unsubscribe = vi.fn();
  vi.spyOn(gateway, "subscribe").mockImplementation((listener) => {
    const detach = subscribe(listener);
    return () => {
      unsubscribe();
      detach();
    };
  });
  const store = projectsForGateway(gateway);
  const detach = store.subscribe(vi.fn());
  onTestFinished(detach);
  return {
    request,
    snapshot,
    gateway,
    store,
    unsubscribe,
    detach,
    emitConfigChanged: () => publishEvent({ type: "event", event: "config.changed", payload: {} }),
    emit: () => publish(snapshot),
    replace: async (projects: ProjectRecord[]) => {
      request.mockResolvedValue({ projects });
      await store.refresh(true);
    },
  };
}

describe("registered project catalog", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });
  it("retires project facts on config publication and reads the current GitHub host", async () => {
    await h.store.refresh();
    expect(h.store.snapshot.ready).toBe(true);
    h.request.mockResolvedValueOnce({ projects: [], githubHost: "new.ghe.example.test" });
    h.emitConfigChanged();
    expect(h.store.snapshot.ready).toBe(false);
    expect(h.store.snapshot.result).toBeNull();
    await h.store.refresh();
    expect(h.store.snapshot.result?.githubHost).toBe("new.ghe.example.test");
  });

  it("shares one cold read across chat and the picker, preserving recents", async () => {
    const picker = projectsForGateway(h.gateway);
    const detach = picker.subscribe(vi.fn());
    onTestFinished(detach);
    expect(picker).toBe(h.store);
    await h.store.refresh();
    expect(h.request).toHaveBeenCalledExactlyOnceWith("projects.list", {});
    expect(h.store.snapshot.repositories).toEqual([
      { owner: "openclaw", repo: "clawsweeper", aliases: ["ClawSweeper"] },
    ]);
    h.snapshot.sessionKey = "agent:other:second";
    h.emit();
    expect(h.request).toHaveBeenCalledTimes(1);
    const recents: ProjectsListResult["recents"] = [
      { kind: "project", projectId: project.id, displayName: project.displayName },
    ];
    h.request.mockResolvedValue({ projects: [project], recents });
    await picker.refresh(true);
    expect(picker.snapshot.result?.recents).toEqual(recents);
  });

  it("retires aliases for every consumer before an invalidating refresh can fail", async () => {
    await h.store.refresh();
    const listener = vi.fn();
    onTestFinished(h.store.subscribe(listener));
    const failed = createDeferred<ProjectsListResult>();
    h.request.mockReturnValueOnce(failed.promise);
    const refresh = h.store.refresh(true);
    const invalidated = h.store.snapshot;
    failed.reject(new Error("catalog unavailable"));
    await refresh;
    expect(invalidated).toEqual({ result: null, repositories: [], ready: false });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(h.store.snapshot).toEqual({ result: null, repositories: [], ready: false });
    await h.replace([{ ...project, originUrl: "https://github.com/replacement/clawsweeper.git" }]);
    expect(h.store.snapshot.repositories).toEqual([
      { owner: "replacement", repo: "clawsweeper", aliases: ["ClawSweeper"] },
    ]);
  });

  it.each(["client", "reconnect", "principal", "scope", "connection"])(
    "rejects a late %s result and loads the current projection",
    async (change) => {
      await h.store.refresh();
      const old = createDeferred<ProjectsListResult>();
      h.request.mockReturnValueOnce(old.promise);
      const pending = h.store.refresh(true);
      const current = { ...project, originUrl: undefined, displayName: "Release Tools" };
      h.request.mockResolvedValue({ projects: [current] });
      if (change === "client") {
        h.snapshot.client = createTestGatewayClient(h.request);
      }
      if (change === "reconnect") {
        h.snapshot.phase = "reconnecting";
        h.emit();
        h.snapshot.phase = "connected";
      }
      if (change === "principal") {
        h.snapshot.hello!.auth!.recoveryScope = "principal-b";
      }
      if (change === "scope") {
        h.snapshot.hello!.auth!.scopes = ["operator.read"];
      }
      if (change === "connection") {
        h.gateway.connection.gatewayUrl = "ws://replacement.test";
      }
      h.emit();
      expect(h.store.snapshot.repositories).toEqual([]);
      await h.store.refresh();
      old.resolve({ projects: [project] });
      await pending;
      expect(h.store.snapshot.result?.projects[0]?.displayName).toBe("Release Tools");
      expect(h.store.snapshot.repositories).toEqual([{ aliases: ["Release Tools"] }]);
      expect(
        markdownGitHubAliases(h.store.snapshot.repositories, { owner: "acme", repo: "tools" }),
      ).toEqual([
        ["release tools", null],
        ["tools", { owner: "acme", repo: "tools" }],
      ]);
    },
  );

  it("clears aliases on read permission loss without requesting wider access", async () => {
    await h.store.refresh();
    h.snapshot.hello!.auth!.scopes = [];
    h.emit();
    expect(h.store.snapshot.repositories).toEqual([]);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("retires pending work and its listener when the final consumer leaves", async () => {
    const pending = createDeferred<ProjectsListResult>();
    h.request.mockReturnValueOnce(pending.promise);
    const request = h.store.refresh(true);
    expect(h.gateway.subscribe).toHaveBeenCalledOnce();
    expect(h.unsubscribe).not.toHaveBeenCalled();
    h.detach();
    expect(h.unsubscribe).toHaveBeenCalledOnce();
    pending.resolve({ projects: [project] });
    await request;
    expect(h.store.snapshot.repositories).toEqual([]);
  });

  it.each([
    "gitlab.com:team/shared.git",
    "[2001:db8::1]:shared.git",
    "ssh://internal/shared.git",
    "https://gitlab.com/team/%73hared.git",
  ])("keeps authorized non-GitHub basename collisions unresolved: %s", async (originUrl) => {
    await h.store.refresh();
    await h.replace([
      {
        ...project,
        displayName: "Public Project",
        originUrl: "https://github.com/acme/shared.git",
      },
      { ...project, id: "internal", displayName: "Internal Service", originUrl },
    ]);
    expect(
      markdownGitHubAliases(h.store.snapshot.repositories).find(([alias]) => alias === "shared"),
    ).toEqual(["shared", null]);
  });

  it.each([
    ["github.com:OpenClaw/ClawSweeper.git", true],
    ["ssh://github.com/OpenClaw/ClawSweeper.git", true],
    ["ssh://github.com:22/OpenClaw/ClawSweeper.git", true],
    ["ssh://github.com:2222/OpenClaw/ClawSweeper.git", false],
    ["ssh://github.com.evil.test/OpenClaw/ClawSweeper.git", false],
    ["https://user:secret@github.com/openclaw/clawsweeper.git", false],
    ["git@evil.test:openclaw/clawsweeper.git", false],
    ["/workspace/clawsweeper", false],
  ])("binds only verified GitHub clone coordinates: %s", async (originUrl, resolves) => {
    await h.store.refresh();
    await h.replace([{ ...project, originUrl }]);
    expect(h.store.snapshot.repositories).toEqual([
      resolves
        ? { owner: "openclaw", repo: "clawsweeper", aliases: ["ClawSweeper"] }
        : { aliases: ["ClawSweeper"] },
    ]);
  });
});
