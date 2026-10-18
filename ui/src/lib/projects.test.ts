import type { ProjectRecord, ProjectsListResult } from "@openclaw/gateway-protocol";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { markdownGitHubAliases } from "../components/markdown-github-repositories.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { watchedGateway } from "./gateway-stores.test-support.ts";
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
  const hello = gatewayHelloForMethods(["projects.list"], ["operator.read", "operator.write"]);
  hello.auth!.recoveryScope = "principal-a";
  const connection = watchedGateway({
    client: createTestGatewayClient(request),
    hello,
    sessionKey: "agent:main:first",
  });
  const { gateway, publish, publishEvent } = connection;
  const snapshot = gateway.snapshot;
  const store = projectsForGateway(gateway);
  const detach = store.subscribe(vi.fn());
  onTestFinished(detach);
  return {
    ...connection,
    request,
    snapshot,
    store,
    detach,
    emitConfigChanged: () => publishEvent({ type: "event", event: "config.changed", payload: {} }),
    emit: () => publish(snapshot),
    replace: async (projects: ProjectRecord[]) => {
      request.mockResolvedValue({ projects });
      await store.refresh(true);
    },
  };
}

it("shares one cold read across chat and the picker, preserving recents", async () => {
  const h = harness();
  const picker = projectsForGateway(h.gateway);
  onTestFinished(picker.subscribe(vi.fn()));
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

describe("registered project catalog", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(async () => {
    h = harness();
    await h.store.refresh();
  });
  it("retires project facts on config publication and reads the current GitHub host", async () => {
    expect(h.store.snapshot.ready).toBe(true);
    h.request.mockResolvedValueOnce({ projects: [], githubHost: "new.ghe.example.test" });
    h.emitConfigChanged();
    expect(h.store.snapshot).toMatchObject({ ready: false, result: null });
    await h.store.refresh();
    expect(h.store.snapshot.result?.githubHost).toBe("new.ghe.example.test");
  });

  it("retires aliases for every consumer before an invalidating refresh can fail", async () => {
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
      const old = createDeferred<ProjectsListResult>();
      h.request.mockReturnValueOnce(old.promise);
      const pending = h.store.refresh(true);
      const current = { ...project, originUrl: undefined, displayName: "Release Tools" };
      h.request.mockResolvedValue({ projects: [current] });
      if (change === "client") {
        h.snapshot.client = createTestGatewayClient(h.request);
      } else if (change === "reconnect") {
        h.snapshot.phase = "reconnecting";
        h.emit();
        h.snapshot.phase = "connected";
      } else if (change === "principal") {
        h.snapshot.hello!.auth!.recoveryScope = "principal-b";
      } else if (change === "scope") {
        h.snapshot.hello!.auth!.scopes = ["operator.read"];
      } else if (change === "connection") {
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
    await h.replace([{ ...project, originUrl }]);
    expect(h.store.snapshot.repositories).toEqual([
      resolves
        ? { owner: "openclaw", repo: "clawsweeper", aliases: ["ClawSweeper"] }
        : { aliases: ["ClawSweeper"] },
    ]);
  });
});
