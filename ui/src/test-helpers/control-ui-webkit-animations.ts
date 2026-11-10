import type { Page } from "playwright";

type AnimationCreated = { animation: { animationId: string } };
type InspectorSession = {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(event: "Animation.animationCreated", listener: (event: AnimationCreated) => void): void;
  off(event: "Animation.animationCreated", listener: (event: AnimationCreated) => void): void;
};
type WebKitPage = {
  _connection?: { toImpl?(page: Page): { delegate?: { _session?: InspectorSession } } };
};

type AnimationSnapshot = {
  type: string;
  name: string;
  connected: boolean;
  playState: string;
  target: string | null;
  pseudoElement: string | null;
};

/** Endpoint-only probe: DOM animation APIs omit detached targets in WebKit. */
export async function readWebKitAnimations(page: Page): Promise<AnimationSnapshot[]> {
  // Same pinned Playwright Inspector connection used by the WebKit heap probe.
  // eslint-disable-next-line no-underscore-dangle -- reuse the pinned Playwright Inspector transport, never attach another client.
  const session = (page as Page & WebKitPage)._connection?.toImpl?.(page).delegate?._session;
  if (!session) {
    throw new Error("WebKit Inspector session is unavailable");
  }
  const ids: string[] = [];
  const created = ({ animation }: AnimationCreated) => {
    ids.push(animation.animationId);
  };
  const objectGroup = "control-ui-animation-census";
  session.on("Animation.animationCreated", created);
  try {
    await session.send("Animation.enable");
    // Drain the existing-instance events before taking the endpoint snapshot.
    await session.send("Runtime.evaluate", { expression: "0", returnByValue: true });
    const snapshots: AnimationSnapshot[] = [];
    for (const animationId of ids) {
      try {
        const { object } = await session.send<{ object: { objectId: string } }>(
          "Animation.resolveAnimation",
          { animationId, objectGroup },
        );
        const result = await session.send<{
          result: { value: AnimationSnapshot };
          wasThrown?: boolean;
        }>("Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration: `function () {
              const target = this.effect?.target;
              return {
                type: this.constructor.name,
                name: this.animationName ?? this.transitionProperty ?? "",
                connected: Boolean(target?.isConnected),
                playState: this.playState,
                target: target instanceof Element ? target.tagName + "." + target.className : null,
                pseudoElement: this.effect?.pseudoElement ?? null,
              };
            }`,
          returnByValue: true,
          generatePreview: false,
        });
        if (
          result.wasThrown ||
          typeof result.result.value?.connected !== "boolean" ||
          typeof result.result.value?.playState !== "string"
        ) {
          throw new Error("Native animation inspection failed");
        }
        snapshots.push(result.result.value);
      } finally {
        // Do not keep Inspector roots alive after inspecting each animation.
        await session.send("Runtime.releaseObjectGroup", { objectGroup });
      }
    }
    return snapshots;
  } finally {
    try {
      await session.send("Animation.disable");
    } finally {
      session.off("Animation.animationCreated", created);
    }
  }
}

export async function countDetachedWebKitShimmers(
  page: Page,
): Promise<{ detached: number; running: number }> {
  const detached = (await readWebKitAnimations(page)).filter(
    (animation) =>
      animation.name === "shimmer" && animation.target !== null && !animation.connected,
  );
  return {
    detached: detached.length,
    running: detached.filter((animation) => animation.playState === "running").length,
  };
}
