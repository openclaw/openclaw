import { describe, expect, it, vi } from "vitest";
import {
  fingerprint,
  formatEd25519PublicKey,
  generateEd25519Signer,
  type MailboxMessage,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { handleStaleSeqRefusal, isStaleSeqRefusal } from "./stale-seq.js";

const message = (deviceFp: string | null, kind = "root_statement"): MailboxMessage =>
  ({
    message_id: "m1",
    claw_id: "c1",
    to: "gateway",
    from: {
      account_id: "acct",
      email: null,
      display_name: null,
      device_fp: deviceFp,
      reported_by: "openclaw-id",
    },
    location_hint: null,
    payload:
      kind === "root_statement" ? { kind, statements: [] } : { kind: "revocation", revocation: {} },
    received_at: 0,
    expires_at: 0,
  }) as MailboxMessage;

const deviceFp = async () =>
  await fingerprint(formatEd25519PublicKey((await generateEd25519Signer()).publicKey));

describe("stale-seq refusals", () => {
  it("recognizes only root statements refused as seq_conflict", () => {
    expect(
      isStaleSeqRefusal(message("fp:a"), { ok: false, code: "seq_conflict", detail: "" }),
    ).toBe(true);
    expect(
      isStaleSeqRefusal(message("fp:a"), { ok: false, code: "bad_signature", detail: "" }),
    ).toBe(false);
    expect(
      isStaleSeqRefusal(message("fp:a", "revocation"), {
        ok: false,
        code: "seq_conflict",
        detail: "",
      }),
    ).toBe(false);
  });

  it("republishes, then tells the sending device the current seq", async () => {
    const fp = await deviceFp();
    const order: string[] = [];
    const sendDeviceNotice = vi.fn(async () => {
      order.push("notice");
      return {} as never;
    });
    await handleStaleSeqRefusal({
      message: message(fp),
      currentSeq: 7,
      republish: async () => {
        order.push("republish");
      },
      target: async () => ({ clawId: "c1", client: { sendDeviceNotice } }),
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect(order).toEqual(["republish", "notice"]);
    expect(sendDeviceNotice).toHaveBeenCalledWith("c1", fp, {
      kind: "notice",
      event: "seq_conflict",
      ref: "7",
    });
  });

  it("republishes without a notice when Discovery did not report the sending device", async () => {
    const republish = vi.fn(async () => {});
    const sendDeviceNotice = vi.fn();
    await handleStaleSeqRefusal({
      message: message(null),
      currentSeq: 3,
      republish,
      target: async () => ({ clawId: "c1", client: { sendDeviceNotice } }),
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect(republish).toHaveBeenCalledTimes(1);
    expect(sendDeviceNotice).not.toHaveBeenCalled();
  });

  it("logs a notice that Discovery refuses instead of failing", async () => {
    const warn = vi.fn();
    await handleStaleSeqRefusal({
      message: message(await deviceFp()),
      currentSeq: 3,
      republish: async () => {},
      target: async () => ({
        clawId: "c1",
        client: {
          sendDeviceNotice: vi.fn(async () => {
            throw new Error("invalid notice");
          }),
        },
      }),
      log: { info: vi.fn(), warn },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("invalid notice"));
  });
});
