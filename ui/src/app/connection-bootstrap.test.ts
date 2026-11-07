import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createConnectionBootstrapCoordinator } from "./connection-bootstrap.ts";

function setup() {
  const coordinator = createConnectionBootstrapCoordinator();
  const started: string[] = [];
  const enqueue = (name: string, key = name, background = false) => {
    const completion = createDeferred();
    const task = coordinator.run(
      key,
      async () => {
        started.push(name);
        await completion.promise;
      },
      { background },
    );
    return { task, resolve: completion.resolve };
  };
  return { coordinator, started, enqueue };
}

describe("connection bootstrap coordinator", () => {
  it("releases cancelled queued work without cancelling started work or freeing its slots", async () => {
    const { coordinator, started, enqueue } = setup();
    coordinator.synchronize({ client: {}, connected: true });
    const first = enqueue("first");
    const second = enqueue("second");
    const retired = enqueue("retired", "owner");
    const settled = vi.fn();
    void retired.task.then(settled);

    coordinator.cancelQueued("owner");
    coordinator.cancelQueued("first");
    await Promise.resolve();
    expect(settled).toHaveBeenCalledOnce();
    const replacement = enqueue("replacement", "owner");
    expect(started).toEqual(["first", "second"]);

    first.resolve();
    await first.task;
    expect(started).toEqual(["first", "second", "replacement"]);
    second.resolve();
    replacement.resolve();
    await Promise.all([second.task, replacement.task]);
  });

  it("does not start queued work after its connection is disconnected", async () => {
    const { coordinator, started, enqueue } = setup();
    coordinator.synchronize({ client: {}, connected: true });
    const tasks = ["first", "second", "stale"].map((name) => enqueue(name));
    expect(started).toEqual(["first", "second"]);
    coordinator.synchronize({ client: null, connected: false });
    tasks.forEach((task) => task.resolve());
    await Promise.all(tasks.map(({ task }) => task));
    expect(started).toEqual(["first", "second"]);
  });

  it("starts a replacement connection while both old tasks remain pending and retains its concurrency", async () => {
    const { coordinator, started, enqueue } = setup();
    coordinator.synchronize({ client: {}, connected: true });
    const runDuplicate = vi.fn(async () => {});
    const previous = [0, 1].map((index) => enqueue(`old-${index}`, `task-${index}`));
    expect(started).toEqual(["old-0", "old-1"]);
    coordinator.synchronize({ client: {}, connected: true });
    const current = [0, 1, 2].map((index) => enqueue(`new-${index}`, `task-${index}`));
    expect(started).toEqual(["old-0", "old-1", "new-0", "new-1"]);

    previous.forEach((entry) => entry.resolve());
    await Promise.all(previous.map(({ task }) => task));
    const duplicateTask = coordinator.run("task-0", runDuplicate);
    expect(runDuplicate).not.toHaveBeenCalled();
    expect(started).toEqual(["old-0", "old-1", "new-0", "new-1"]);

    current[0]!.resolve();
    await vi.waitFor(() => expect(started).toEqual(["old-0", "old-1", "new-0", "new-1", "new-2"]));
    current.forEach((entry) => entry.resolve());
    await Promise.all([...current.map(({ task }) => task), duplicateTask]);
    await coordinator.run("task-0", runDuplicate);

    expect(runDuplicate).toHaveBeenCalledOnce();
  });

  it("pauses only background work until the selected transcript is authoritative, then drains it in order", async () => {
    const { coordinator, started, enqueue } = setup();
    const client = {};
    const pane = {};
    const retiredPane = {};
    const sessionKey = "agent:main:selected";
    const expectStarted = (...background: string[]) =>
      expect(started).toEqual(["route-prerequisite", ...background]);
    coordinator.setForegroundRoute(undefined);
    coordinator.synchronize({ client, connected: true });
    const background = [0, 1, 2].map((index) => enqueue(`background-${index}`, undefined, true));
    await coordinator.run("route-prerequisite", async () => {
      started.push("route-prerequisite");
    });
    expectStarted();
    expect(coordinator.foregroundReady).toBe(false);

    coordinator.setForegroundPane(retiredPane, { sessionKey, client, ready: true });
    expectStarted(); // An unresolved route has not selected that transcript.
    coordinator.setForegroundPane(retiredPane, null);
    coordinator.setForegroundRoute(sessionKey);
    expectStarted(); // A retired pane cannot satisfy the newly resolved route.
    for (const state of [
      { sessionKey, client: null, ready: true },
      { sessionKey, client: {}, ready: true },
      { sessionKey, client, ready: false },
      { sessionKey: "agent:main:other", client, ready: true },
    ]) {
      coordinator.setForegroundPane(pane, state);
      expectStarted();
      expect(coordinator.foregroundReady).toBe(false);
    }
    coordinator.setForegroundPane(retiredPane, null);
    coordinator.setForegroundPane(pane, { sessionKey, client, ready: true });
    expect(coordinator.foregroundReady).toBe(true);
    await vi.waitFor(() => expectStarted("background-0", "background-1"));
    background[0]!.resolve();
    await vi.waitFor(() => expectStarted("background-0", "background-1", "background-2"));
    background.forEach((entry) => entry.resolve());
    await Promise.all(background.map(({ task }) => task));
  });

  it("releases bulk work when navigation leaves or rejects the native chat route", async () => {
    const coordinator = createConnectionBootstrapCoordinator();
    const client = {};
    const pane = {};
    coordinator.setForegroundRoute("agent:main:selected");
    coordinator.synchronize({ client, connected: true });
    coordinator.setForegroundPane(pane, {
      sessionKey: "agent:main:selected",
      client,
      ready: false,
    });
    const hydrate = vi.fn(async () => {});
    const background = coordinator.run("roster", hydrate, { background: true });
    expect(hydrate).not.toHaveBeenCalled();

    coordinator.setForegroundRoute(null);
    await background;
    expect(hydrate).toHaveBeenCalledOnce();
  });

  it("runs connected bootstrap work queued by an earlier subscription", async () => {
    const coordinator = createConnectionBootstrapCoordinator();
    const hydrate = vi.fn(async () => {});

    const queued = coordinator.run("sessions", hydrate);
    await Promise.resolve();
    expect(hydrate).not.toHaveBeenCalled();

    coordinator.synchronize({ client: {}, connected: true });
    await queued;

    expect(hydrate).toHaveBeenCalledOnce();
  });
});
