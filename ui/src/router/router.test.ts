import { describe, expect, it } from "vitest";
import { createRouter } from "./router.ts";

describe("createRouter", () => {
  it("matches canonical and alias paths through one compiled path index", () => {
    const router = createRouter({
      defaultRouteId: "home",
      routes: [
        { id: "home", path: "/home" },
        { id: "dreams", path: "/dreaming", aliases: ["/dreams"] },
      ],
    });

    expect(router.routeIdFromPath("/")).toBe("home");
    expect(router.routeIdFromPath("/DREAMS")).toBe("dreams");
    expect(router.matchPath("/dreaming")?.id).toBe("dreams");
    expect(router.pathForRoute("dreams", "/ui")).toBe("/ui/dreaming");
  });

  it("does not enter the next route after a cancelled async leave", async () => {
    let releaseLeave: (() => void) | null = null;
    let markLeaveStarted: (() => void) | null = null;
    const leaveStarted = new Promise<void>((resolve) => {
      markLeaveStarted = resolve;
    });
    const calls: string[] = [];
    const router = createRouter({
      routes: [
        {
          id: "from",
          path: "/from",
          page: async () => ({
            page: {
              onLeave: () =>
                new Promise<void>((resolve) => {
                  calls.push("leave");
                  releaseLeave = resolve;
                  markLeaveStarted?.();
                }),
              render: () => null,
            },
          }),
        },
        {
          id: "to",
          path: "/to",
          page: async () => ({
            page: {
              onEnter: () => {
                calls.push("enter");
              },
              render: () => null,
            },
          }),
        },
      ],
    });

    const controller = new AbortController();
    const transition = router.transition(
      "from",
      "to",
      { invalidate: () => undefined },
      {
        signal: controller.signal,
      },
    );
    await leaveStarted;
    controller.abort();
    releaseLeave?.();
    await transition;

    expect(calls).toEqual(["leave"]);
  });

  it("does not run a lazy route hook after cancellation during module load", async () => {
    let markModuleStarted: (() => void) | null = null;
    let resolveModule:
      | ((module: {
          page: {
            onEnter: () => void;
            render: () => null;
          };
        }) => void)
      | null = null;
    const moduleStarted = new Promise<void>((resolve) => {
      markModuleStarted = resolve;
    });
    const calls: string[] = [];
    const router = createRouter({
      routes: [
        {
          id: "logs",
          path: "/logs",
          page: async () => {
            markModuleStarted?.();
            return new Promise((resolve) => {
              resolveModule = resolve;
            });
          },
        },
      ],
    });
    const controller = new AbortController();
    const enter = router.enter(
      "logs",
      { invalidate: () => undefined },
      {
        signal: controller.signal,
      },
    );

    await moduleStarted;
    controller.abort();
    resolveModule?.({
      page: {
        onEnter: () => calls.push("enter"),
        render: () => null,
      },
    });
    await enter;

    expect(calls).toEqual([]);
  });
});
