import { describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  ProjectRecord,
  ProjectsListResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { markdownGitHubAliases } from "../components/markdown-github-repositories.ts";
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
  const listeners = new Set<() => void>();
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
  const gateway: ApplicationGateway = {
    snapshot,
    connectionRevision: 0,
    connection: { gatewayUrl: "ws://example.test", token: "", password: "", bootstrapToken: "" },
    eventLog: [],
    eventLogRevision: 0,
    connect: vi.fn(),
    setSessionKey: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    subscribe: (listener) => {
      const notify = () => listener(snapshot);
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    subscribeEvents: () => () => {},
    subscribeEventLog: () => () => {},
  };
  const store = projectsForGateway(gateway);
  const detach = store.subscribe(vi.fn());
  onTestFinished(detach);
  return {
    request,
    snapshot,
    gateway,
    store,
    listeners,
    detach,
    emit: () => {
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

describe("registered project catalog", () => {
  it("shares one cold read across chat and the picker, preserving recents", async () => {
    const h = harness();
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
    const h = harness();
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
    expect(h.store.snapshot).toEqual({ result: null, repositories: [], ready: true });
    h.request.mockResolvedValue({
      projects: [{ ...project, originUrl: "https://github.com/replacement/clawsweeper.git" }],
    });
    await h.store.refresh(true);
    expect(h.store.snapshot.repositories).toEqual([
      { owner: "replacement", repo: "clawsweeper", aliases: ["ClawSweeper"] },
    ]);
  });

  it.each(["client", "reconnect", "principal", "scope", "connection"])(
    "rejects a late %s result and loads the current projection",
    async (change) => {
      const h = harness();
      await h.store.refresh();
      const old = createDeferred<ProjectsListResult>();
      h.request.mockReturnValueOnce(old.promise);
      const pending = h.store.refresh(true);
      const current = { ...project, originUrl: undefined, displayName: "Hidden Project" };
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
      expect(h.store.snapshot.repositories).toEqual([{ aliases: ["Hidden Project"] }]);
    },
  );

  it("keeps read-only display names unresolved without inventing hidden origin aliases", async () => {
    const h = harness();
    await h.store.refresh();
    h.snapshot.hello!.auth!.scopes = ["operator.read"];
    h.request.mockResolvedValue({
      projects: [{ ...project, displayName: "Release Tools", originUrl: undefined }],
    });
    h.emit();
    await h.store.refresh();
    expect(h.store.snapshot.result?.projects[0]?.displayName).toBe("Release Tools");
    expect(h.store.snapshot.repositories).toEqual([{ aliases: ["Release Tools"] }]);
    expect(
      markdownGitHubAliases(h.store.snapshot.repositories, { owner: "acme", repo: "tools" }),
    ).toEqual([
      ["release tools", null],
      ["tools", { owner: "acme", repo: "tools" }],
    ]);
  });

  it("clears aliases on read permission loss without requesting wider access", async () => {
    const h = harness();
    await h.store.refresh();
    h.snapshot.hello!.auth!.scopes = [];
    h.emit();
    expect(h.store.snapshot.repositories).toEqual([]);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("retires pending work and its listener when the final consumer leaves", async () => {
    const h = harness();
    const pending = createDeferred<ProjectsListResult>();
    h.request.mockReturnValueOnce(pending.promise);
    const request = h.store.refresh(true);
    // The fixture's first subscription also represents a mounted consumer.
    expect(h.listeners.size).toBe(1);
    h.detach();
    expect(h.listeners.size).toBe(0);
    pending.resolve({ projects: [project] });
    await request;
    expect(h.store.snapshot.repositories).toEqual([]);
  });

  it.each([
    "https://gitlab.com/team/shared.git",
    "gitlab.com:team/shared.git",
    "internal:team/shared.git",
    "internal:shared.git",
    "[2001:db8::1]:shared.git",
    "ssh://internal/shared.git",
    "https://gitlab.com/team/%73hared.git",
  ])("keeps authorized non-GitHub basename collisions unresolved: %s", async (originUrl) => {
    const h = harness();
    await h.store.refresh();
    h.request.mockResolvedValue({
      projects: [
        {
          ...project,
          displayName: "Public Project",
          originUrl: "https://github.com/acme/shared.git",
        },
        { ...project, id: "internal", displayName: "Internal Service", originUrl },
      ],
    });
    await h.store.refresh(true);
    expect(
      markdownGitHubAliases(h.store.snapshot.repositories).find(([alias]) => alias === "shared"),
    ).toEqual(["shared", null]);
  });

  it.each([
    ["https://github.com/OpenClaw/ClawSweeper.git", true],
    ["git@github.com:OpenClaw/ClawSweeper.git", true],
    ["github.com:OpenClaw/ClawSweeper.git", true],
    ["ssh://git@github.com/OpenClaw/ClawSweeper.git", true],
    ["ssh://github.com/OpenClaw/ClawSweeper.git", true],
    ["ssh://github.com:22/OpenClaw/ClawSweeper.git", true],
    ["ssh://github.com:2222/OpenClaw/ClawSweeper.git", false],
    ["ssh://github.com.evil.test/OpenClaw/ClawSweeper.git", false],
    ["https://gitlab.com/openclaw/clawsweeper.git", false],
    ["https://user:secret@github.com/openclaw/clawsweeper.git", false],
    ["git@evil.test:openclaw/clawsweeper.git", false],
    ["/workspace/clawsweeper", false],
    [undefined, false],
  ])("binds only verified GitHub clone coordinates: %s", async (originUrl, resolves) => {
    const h = harness();
    await h.store.refresh();
    h.request.mockResolvedValue({ projects: [{ ...project, originUrl }] });
    await h.store.refresh(true);
    expect(h.store.snapshot.repositories).toEqual([
      resolves
        ? { owner: "openclaw", repo: "clawsweeper", aliases: ["ClawSweeper"] }
        : { aliases: ["ClawSweeper"] },
    ]);
  });
});
