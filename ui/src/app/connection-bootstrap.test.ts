import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createConnectionBootstrapCoordinator } from "./connection-bootstrap.ts";

describe("connection bootstrap coordinator", () => {
  it("deduplicates bootstrap work and caps its connection concurrency", async () => {
    const coordinator = createConnectionBootstrapCoordinator();
    coordinator.synchronize({ client: {}, connected: true });
    let active = 0;
    let maximum = 0;
    const first = createDeferred();
    const second = createDeferred();
    const third = createDeferred();
    const run = (completion: ReturnType<typeof createDeferred<void>>) => async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await completion.promise;
      active -= 1;
    };

    const firstTask = coordinator.run("first", run(first));
    const duplicateFirstTask = coordinator.run("first", run(first));
    const secondTask = coordinator.run("second", run(second));
    const thirdTask = coordinator.run("third", run(third));

    await vi.waitFor(() => expect(maximum).toBe(2));
    first.resolve();
    await Promise.all([firstTask, duplicateFirstTask]);
    expect(maximum).toBe(2);
    second.resolve();
    third.resolve();
    await Promise.all([secondTask, thirdTask]);
    expect(maximum).toBe(2);
  });

  it.each(["reset", "disconnected", "replaced"])(
    "does not start queued work after its connection is %s",
    async (boundary) => {
      const coordinator = createConnectionBootstrapCoordinator();
      coordinator.synchronize({ client: {}, connected: true });
      const first = createDeferred();
      const second = createDeferred();
      let boundaryReturned = false;
      let startedAfterBoundary = false;
      let staleStarted = false;
      const block = (completion: ReturnType<typeof createDeferred<void>>) => async () => {
        startedAfterBoundary ||= boundaryReturned;
        await completion.promise;
      };
      const firstTask = coordinator.run("first", block(first));
      const secondTask = coordinator.run("second", block(second));
      const staleTask = coordinator.run("stale", async () => {
        startedAfterBoundary ||= boundaryReturned;
        staleStarted = true;
      });

      if (boundary === "reset") {
        coordinator.reset();
      } else {
        coordinator.synchronize({
          client: boundary === "replaced" ? {} : null,
          connected: boundary === "replaced",
        });
      }
      boundaryReturned = true;
      first.resolve();
      second.resolve();
      await Promise.all([firstTask, secondTask, staleTask]);
      expect(startedAfterBoundary).toBe(false);
      expect(staleStarted).toBe(false);
    },
  );

  it("starts a replacement connection while both old tasks remain pending and retains its concurrency", async () => {
    const coordinator = createConnectionBootstrapCoordinator();
    coordinator.synchronize({ client: {}, connected: true });
    const previous = [createDeferred(), createDeferred()];
    const current = [createDeferred(), createDeferred(), createDeferred()];
    const started: string[] = [];
    const run = (name: string, deferred: ReturnType<typeof createDeferred<void>>) => async () => {
      started.push(name);
      await deferred.promise;
    };
    const runDuplicate = vi.fn(async () => {});
    const previousTasks = previous.map((deferred, index) =>
      coordinator.run(`task-${index}`, run(`old-${index}`, deferred)),
    );

    expect(started).toEqual(["old-0", "old-1"]);
    coordinator.synchronize({ client: {}, connected: true });
    const currentTasks = current.map((deferred, index) =>
      coordinator.run(`task-${index}`, run(`new-${index}`, deferred)),
    );
    expect(started).toEqual(["old-0", "old-1", "new-0", "new-1"]);

    previous.forEach((deferred) => deferred.resolve());
    await Promise.all(previousTasks);
    const duplicateTask = coordinator.run("task-0", runDuplicate);
    expect(runDuplicate).not.toHaveBeenCalled();
    expect(started).toEqual(["old-0", "old-1", "new-0", "new-1"]);

    current[0]!.resolve();
    await vi.waitFor(() => expect(started).toEqual(["old-0", "old-1", "new-0", "new-1", "new-2"]));
    current.forEach((deferred) => deferred.resolve());
    await Promise.all([...currentTasks, duplicateTask]);
    await coordinator.run("task-0", runDuplicate);

    expect(runDuplicate).toHaveBeenCalledOnce();
  });

  it("pauses only background work until the selected transcript is authoritative, then drains it in order", async () => {
    const coordinator = createConnectionBootstrapCoordinator();
    const client = {};
    const pane = {};
    const retiredPane = {};
    const sessionKey = "agent:main:selected";
    const started: string[] = [];
    const completion = [createDeferred(), createDeferred(), createDeferred()];
    coordinator.setForegroundRoute(undefined);
    coordinator.synchronize({ client, connected: true });
    const background = completion.map((deferred, index) =>
      coordinator.run(
        `background-${index}`,
        async () => {
          started.push(`background-${index}`);
          await deferred.promise;
        },
        { background: true },
      ),
    );
    await coordinator.run("route-prerequisite", async () => {
      started.push("route-prerequisite");
    });
    expect(started).toEqual(["route-prerequisite"]);

    coordinator.setForegroundPane(retiredPane, { sessionKey, client, ready: true });
    expect(started, "an unresolved route has not selected that transcript").toEqual([
      "route-prerequisite",
    ]);
    coordinator.setForegroundPane(retiredPane, null);
    coordinator.setForegroundRoute(sessionKey);
    expect(started, "a retired pane cannot satisfy the newly resolved route").toEqual([
      "route-prerequisite",
    ]);
    for (const state of [
      { sessionKey, client: null, ready: true },
      { sessionKey, client: {}, ready: true },
      { sessionKey, client, ready: false },
      { sessionKey: "agent:main:other", client, ready: true },
    ]) {
      coordinator.setForegroundPane(pane, state);
      expect(
        started,
        "cached, old, pending, and other-session facts cannot release bulk reads",
      ).toEqual(["route-prerequisite"]);
    }
    coordinator.setForegroundPane(retiredPane, null);
    coordinator.setForegroundPane(pane, { sessionKey, client, ready: true });
    await vi.waitFor(() =>
      expect(started).toEqual(["route-prerequisite", "background-0", "background-1"]),
    );
    completion[0]!.resolve();
    await vi.waitFor(() =>
      expect(started).toEqual([
        "route-prerequisite",
        "background-0",
        "background-1",
        "background-2",
      ]),
    );
    completion.forEach((deferred) => deferred.resolve());
    await Promise.all(background);
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

  it("releases failed work for another automatic attempt", async () => {
    const coordinator = createConnectionBootstrapCoordinator();
    coordinator.synchronize({ client: {}, connected: true });
    const retry = vi.fn(async () => {});

    await expect(
      coordinator.run("runtime-config", async () => {
        throw new Error("network unavailable");
      }),
    ).resolves.toBeUndefined();
    await coordinator.run("runtime-config", retry);

    expect(retry).toHaveBeenCalledOnce();
  });

  it("releases fulfilled work for a later automatic refresh", async () => {
    const coordinator = createConnectionBootstrapCoordinator();
    coordinator.synchronize({ client: {}, connected: true });
    const refresh = vi.fn(async () => {});

    await coordinator.run("runtime-config", refresh);
    await coordinator.run("runtime-config", refresh);

    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
