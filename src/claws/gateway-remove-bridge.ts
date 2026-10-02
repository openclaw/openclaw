import type { ChildProcess } from "node:child_process";
import { Duplex } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import type { ClawCronGateway } from "./cron.js";
import type { ClawMonitorCleanupGateway } from "./monitor-cleanup-contract.js";
import type { ClawPackageRemovalGateway } from "./package-remove-contract.js";
import {
  CLAW_REMOVE_AUTHORITY_DENIED,
  CLAW_REMOVE_AUTHORITY_GRANTED,
  CLAW_REMOVE_AUTHORITY_REQUEST,
  clawRemoveBridgeRequestSchema,
  type ClawRemoveBridgeRequest,
  type ClawRemoveBridgeResponse,
} from "./remove-gateway-bridge-protocol.js";
import { MAX_CLAW_MANIFEST_BYTES } from "./source-limits.js";

type ClawRemoveGatewayCallbacks = {
  monitorGateway: ClawMonitorCleanupGateway;
  packageGateway: ClawPackageRemovalGateway;
  cronGateway: {
    get: NonNullable<ClawCronGateway["get"]>;
    remove: ClawCronGateway["remove"];
  };
};

type ClawRemoveGatewayBridgeBase = {
  agentId: string;
  assertCurrent: () => void;
};

type ClawRemoveGatewayPreviewBridge = ClawRemoveGatewayBridgeBase & {
  previewOnly: true;
  monitorGateway: Pick<ClawMonitorCleanupGateway, "inspect">;
};

export type ClawRemoveGatewayApplyBridge = ClawRemoveGatewayBridgeBase & {
  previewOnly?: false;
  allowedCronJobIds: ReadonlySet<string>;
  createCallbacks: (assertCurrent: () => void) => ClawRemoveGatewayCallbacks;
};

export type ClawRemoveGatewayBridge = ClawRemoveGatewayPreviewBridge | ClawRemoveGatewayApplyBridge;

function requestSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null");
}

/** Attach only the Claw Remove callbacks and fd3 authority gate to this local CLI child. */
export function attachClawRemoveGatewayBridge(
  child: ChildProcess,
  bridge: ClawRemoveGatewayBridge,
  abort: (reason: Error) => void,
): void {
  const control = child.stdio[3];
  if (!(control instanceof Duplex) || !child.send) {
    throw new Error("Claw removal child has no private authority channel.");
  }
  let active = true;
  const assertCurrent = () => {
    if (!active) {
      throw new Error("Claw removal child is no longer active.");
    }
    try {
      bridge.assertCurrent();
    } catch (error) {
      const denial = error instanceof Error ? error : new Error("Claw authority retired.");
      abort(denial);
      throw denial;
    }
  };
  const callbacks = bridge.previewOnly ? undefined : bridge.createCallbacks(assertCurrent);
  const retire = () => {
    active = false;
  };
  child.once("exit", retire);
  child.once("disconnect", retire);
  control.on("error", (error) => {
    if (active) {
      abort(error instanceof Error ? error : new Error("Claw authority channel failed."));
    }
  });
  control.on("data", (chunk: Buffer) => {
    for (const byte of chunk) {
      let denial: Error | undefined;
      if (byte !== CLAW_REMOVE_AUTHORITY_REQUEST) {
        denial = new Error("Invalid Claw authority request.");
      } else {
        try {
          // This grant admits one in-flight synchronous check; retirement denies the next one.
          assertCurrent();
        } catch (error) {
          denial = error instanceof Error ? error : new Error("Claw authority retired.");
        }
      }
      control.write(
        Buffer.from([denial ? CLAW_REMOVE_AUTHORITY_DENIED : CLAW_REMOVE_AUTHORITY_GRANTED]),
      );
      if (denial) {
        abort(denial);
        return;
      }
    }
  });

  const send = (response: ClawRemoveBridgeResponse) => {
    if (!active || !child.connected) {
      return;
    }
    child.send?.(response, (error) => {
      if (error && active) {
        abort(error);
      }
    });
  };
  const dispatch = async (request: ClawRemoveBridgeRequest): Promise<unknown> => {
    assertCurrent();
    if (bridge.previewOnly) {
      if (request.op !== "monitor.inspect" || request.agentId !== bridge.agentId) {
        throw new Error("Claw removal preview permits only monitor inspection for its agent.");
      }
      return await bridge.monitorGateway.inspect(request.agentId);
    }
    if (!callbacks) {
      throw new Error("Claw removal callbacks are unavailable.");
    }
    switch (request.op) {
      case "monitor.inspect": {
        if (request.agentId !== bridge.agentId) {
          throw new Error("Claw monitor target changed.");
        }
        return await callbacks.monitorGateway.inspect(request.agentId);
      }
      case "monitor.quiesce": {
        if (request.agentId !== bridge.agentId) {
          throw new Error("Claw monitor target changed.");
        }
        await callbacks.monitorGateway.quiesce(
          request.agentId,
          request.operationId,
          request.monitors,
        );
        return null;
      }
      case "monitor.drain": {
        if (request.agentId !== bridge.agentId) {
          throw new Error("Claw monitor target changed.");
        }
        await callbacks.monitorGateway.drain(request.agentId, request.operationId);
        return null;
      }
      case "package.remove": {
        if (
          request.request.agentId !== bridge.agentId ||
          !isDeepStrictEqual(request.request.cleanup, {
            mode: "retain",
            selected: [],
            allowConflicts: false,
          })
        ) {
          throw new Error("Claw package cleanup changed from the reviewed plan.");
        }
        return await callbacks.packageGateway(request.request);
      }
      case "cron.get": {
        if (!bridge.allowedCronJobIds.has(request.schedulerJobId)) {
          throw new Error("Claw cron target changed.");
        }
        return (await callbacks.cronGateway.get(request.schedulerJobId)) ?? null;
      }
      case "cron.remove": {
        if (!bridge.allowedCronJobIds.has(request.schedulerJobId)) {
          throw new Error("Claw cron target changed.");
        }
        await callbacks.cronGateway.remove(request.schedulerJobId, {
          expectedConfigRevision: request.expectedConfigRevision,
          commitGuard: assertCurrent,
        });
        return null;
      }
    }
    throw new Error("Unsupported Claw removal request.");
  };
  child.on("message", (message: unknown) => {
    if (!active) {
      return;
    }
    const parsed =
      requestSize(message) <= MAX_CLAW_MANIFEST_BYTES
        ? clawRemoveBridgeRequestSchema.safeParse(message)
        : undefined;
    if (!parsed?.success) {
      abort(new Error("Invalid Claw removal child request."));
      return;
    }
    void (async () => {
      try {
        const value = await dispatch(parsed.data);
        assertCurrent();
        if (requestSize(value) > MAX_CLAW_MANIFEST_BYTES) {
          throw new Error("Claw removal callback response is too large.");
        }
        send({ kind: "claw.remove.response", id: parsed.data.id, ok: true, value });
      } catch (error) {
        const failureMessage =
          error instanceof Error ? error.message : "Claw removal callback failed.";
        send({
          kind: "claw.remove.response",
          id: parsed.data.id,
          ok: false,
          error: failureMessage.slice(0, 8192),
        });
      }
    })();
  });
}
