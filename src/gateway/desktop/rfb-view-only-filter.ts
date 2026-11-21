const RFB_3_8_VERSION = Buffer.from("RFB 003.008\n", "ascii");
const MAX_PENDING_BYTES = 64 * 1024;

type RfbClientPhase = "version" | "security" | "authResponse" | "clientInit" | "messages";
const FIXED_PHASE_LENGTHS: Record<Exclude<RfbClientPhase, "messages">, number> = {
  version: RFB_3_8_VERSION.length,
  security: 1,
  authResponse: 16,
  clientInit: 1,
};

const MESSAGE_LENGTHS = new Map<number, number | ((pending: Buffer) => number)>([
  [0, 20],
  [2, (pending) => (pending.length < 4 ? 4 : 4 + pending.readUInt16BE(2) * 4)],
  [3, 10],
  [4, 8],
  // noVNC's extended pointer marker appends one byte for buttons 8-15.
  [5, (pending) => (pending.length < 2 ? 2 : (pending.readUInt8(1) & 0x80) !== 0 ? 7 : 6)],
  // Extended clipboard payloads use a negative signed length.
  [6, (pending) => (pending.length < 8 ? 8 : 8 + Math.abs(pending.readInt32BE(4)))],
  [150, 10],
  // ClientFence's payload length follows its 8-byte fixed header.
  [248, (pending) => (pending.length < 9 ? 9 : 9 + pending.readUInt8(8))],
  // noVNC sends one fixed 16-byte screen record in SetDesktopSize.
  [251, 24],
  // QEMU extended key: type, subtype, down flag, keysym, keycode.
  [255, 12],
]);

type RfbClientMessageFilterResult =
  | { forward: Buffer; error?: never }
  | { forward?: never; error: string };

/** Filters one view-only RFB client byte stream without trusting WebSocket frame boundaries. */
export function createRfbClientMessageFilter(
  options: { startPhase?: "version" | "clientInit" } = {},
) {
  let phase: RfbClientPhase = options.startPhase ?? "version";
  let pending = Buffer.alloc(0);
  let failure: string | undefined;

  const fail = (error: string): RfbClientMessageFilterResult => {
    failure = error;
    pending = Buffer.alloc(0);
    return { error };
  };

  const pendingTargetLength = (): number | string => {
    if (phase !== "messages") {
      return FIXED_PHASE_LENGTHS[phase];
    }
    if (pending.length === 0) {
      return 1;
    }
    const length = MESSAGE_LENGTHS.get(pending[0] ?? -1);
    return typeof length === "function"
      ? length(pending)
      : (length ?? `unsupported RFB client message type ${pending[0]}`);
  };

  const routePending = (forwarded: Buffer[]): string | undefined => {
    const shouldForward = phase !== "messages" || [0, 2, 3, 150, 248].includes(pending[0] ?? -1);
    if (phase === "version") {
      if (!pending.equals(RFB_3_8_VERSION)) {
        return "unsupported RFB protocol version";
      }
      phase = "security";
    } else if (phase === "security") {
      const securityType = pending[0];
      if (securityType === 1) {
        phase = "clientInit";
      } else if (securityType === 2) {
        phase = "authResponse";
      } else {
        return `unsupported RFB security type ${securityType}`;
      }
    } else if (phase === "authResponse") {
      phase = "clientInit";
    } else if (phase === "clientInit") {
      // A passive viewer must stay shared; exclusive ClientInit would disconnect the controller.
      pending[0] = 1;
      phase = "messages";
    }
    if (shouldForward) {
      forwarded.push(pending);
    }
    pending = Buffer.alloc(0);
    return undefined;
  };

  return {
    filter(chunk: Buffer): RfbClientMessageFilterResult {
      if (failure) {
        return { error: failure };
      }
      const forwarded: Buffer[] = [];
      let offset = 0;
      while (offset < chunk.length || pending.length > 0) {
        const target = pendingTargetLength();
        if (typeof target === "string") {
          return fail(target);
        }
        if (target > MAX_PENDING_BYTES) {
          return fail("RFB client message exceeds the 64 KiB buffer limit");
        }
        if (pending.length < target) {
          if (offset === chunk.length) {
            break;
          }
          const take = Math.min(target - pending.length, chunk.length - offset);
          pending = Buffer.concat([pending, chunk.subarray(offset, offset + take)]);
          offset += take;
          continue;
        }
        const error = routePending(forwarded);
        if (error) {
          return fail(error);
        }
      }
      return { forward: Buffer.concat(forwarded) };
    },
  };
}
