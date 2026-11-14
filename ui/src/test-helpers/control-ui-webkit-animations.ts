import type { Page } from "playwright";

type AnimationCreated = { animation: { animationId: string; cssAnimationName?: string } };
type InspectorSession = {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(event: "Animation.animationCreated", listener: (event: AnimationCreated) => void): void;
  off(event: "Animation.animationCreated", listener: (event: AnimationCreated) => void): void;
};
type WebKitPage = {
  _connection?: { toImpl?(page: Page): { delegate?: { _session?: InspectorSession } } };
};

/** Endpoint-only probe: DOM animation APIs omit detached targets in WebKit. */
export async function countDetachedWebKitShimmers(
  page: Page,
): Promise<{ detached: number; running: number }> {
  // Same pinned Playwright Inspector connection used by the WebKit heap probe.
  // eslint-disable-next-line no-underscore-dangle -- reuse the pinned Playwright Inspector transport, never attach another client.
  const session = (page as Page & WebKitPage)._connection?.toImpl?.(page).delegate?._session;
  if (!session) {
    throw new Error("WebKit Inspector session is unavailable");
  }
  const ids: string[] = [];
  const created = ({ animation }: AnimationCreated) => {
    if (animation.cssAnimationName === "shimmer") {
      ids.push(animation.animationId);
    }
  };
  const objectGroup = "detached-shimmer-census";
  session.on("Animation.animationCreated", created);
  try {
    await session.send("Animation.enable");
    // Drain the existing-instance events before taking the endpoint snapshot.
    await session.send("Runtime.evaluate", { expression: "0", returnByValue: true });
    const counts = { detached: 0, running: 0 };
    for (const animationId of ids) {
      try {
        const { object } = await session.send<{ object: { objectId: string } }>(
          "Animation.resolveAnimation",
          { animationId, objectGroup },
        );
        const result = await session.send<{
          result: { value: { detached: boolean; running: boolean } };
          wasThrown?: boolean;
        }>("Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration: `function () {
              const detached = this.animationName === "shimmer" &&
                this.effect?.target instanceof Element && !this.effect.target.isConnected;
              return { detached: Boolean(detached), running: detached && this.playState === "running" };
            }`,
          returnByValue: true,
          generatePreview: false,
        });
        if (
          result.wasThrown ||
          typeof result.result.value?.detached !== "boolean" ||
          typeof result.result.value?.running !== "boolean"
        ) {
          throw new Error("Native animation inspection failed");
        }
        counts.detached += Number(result.result.value.detached);
        counts.running += Number(result.result.value.running);
      } finally {
        // Do not keep Inspector roots alive after inspecting each animation.
        await session.send("Runtime.releaseObjectGroup", { objectGroup });
      }
    }
    return counts;
  } finally {
    try {
      await session.send("Animation.disable");
    } finally {
      session.off("Animation.animationCreated", created);
    }
  }
}
