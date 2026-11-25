import { createMemo } from "solid-js";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import { projectGateway } from "../reactive/application.ts";
import { useOptionalApplication } from "../reactive/context.ts";

/** Raw Canvas documents keep presentation custody, not transport authority. */
export function createCanvasFramePresentation(
  contentKey: () => string,
  source: () => string | undefined,
  initialized: () => boolean,
) {
  const context = useOptionalApplication();
  const gateway = context ? projectGateway(context.gateway) : undefined;
  const identity = createMemo(
    () => {
      const current = gateway?.read();
      const snapshot = current?.snapshot;
      if (
        snapshot &&
        (!snapshot.client ||
          snapshot.phase === "stopped" ||
          snapshot.lastErrorAuthReason ||
          (snapshot.phase === "connected" &&
            snapshot.hello &&
            !hasOperatorReadAccess(snapshot.hello.auth ?? null)))
      ) {
        return undefined;
      }
      return {
        key: contentKey(),
        client: snapshot?.client,
        scope: context ? gatewayPresentationScope(context.gateway).key : 0,
      };
    },
    {
      equals: (previous, next) =>
        previous?.key === next?.key &&
        previous?.client === next?.client &&
        previous?.scope === next?.scope,
    },
  );
  const retained = createMemo<
    { identity: ReturnType<typeof identity>; src: string | undefined } | undefined
  >((previous) => {
    const owner = identity();
    if (!owner) {
      return undefined;
    }
    const src = source();
    if (
      previous?.identity === owner &&
      (initialized() || (gateway && gateway.read().snapshot.phase !== "connected"))
    ) {
      return previous;
    }
    return { identity: owner, src };
  });
  return {
    identity,
    src: () => retained()?.src,
    active: () => {
      const snapshot = context?.gateway.snapshot;
      return (
        !snapshot ||
        (snapshot.phase === "connected" &&
          !snapshot.lastErrorAuthReason &&
          hasOperatorReadAccess(snapshot.hello?.auth ?? null))
      );
    },
  };
}
