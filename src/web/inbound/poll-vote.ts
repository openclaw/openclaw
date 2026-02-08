import { proto } from "@whiskeysockets/baileys";
import crypto from "node:crypto";
import type { StoredPoll } from "./poll-store.js";

export interface DecryptedPollVote {
  selectedOptions: string[];
}

export function decryptPollVote(
  vote: { encPayload: Buffer | Uint8Array; encIv: Buffer | Uint8Array },
  ctx: { pollCreatorJid: string; pollMsgId: string; pollEncKey: Buffer; voterJid: string },
): proto.Message.IPollVoteMessage {
  const sign = Buffer.concat([
    Buffer.from(ctx.pollMsgId),
    Buffer.from(ctx.pollCreatorJid),
    Buffer.from(ctx.voterJid),
    Buffer.from("Poll Vote"),
    Buffer.from([1]),
  ]);
  const key0 = crypto.createHmac("sha256", ctx.pollEncKey).update(Buffer.alloc(32)).digest();
  const decKey = crypto.createHmac("sha256", key0).update(sign).digest();
  const aad = Buffer.from(`${ctx.pollMsgId}\0${ctx.voterJid}`);
  const payload = Buffer.from(vote.encPayload);
  const ciphertext = payload.slice(0, -16);
  const tag = payload.slice(-16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", decKey, Buffer.from(vote.encIv));
  decipher.setAuthTag(tag);
  decipher.setAAD(aad);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return proto.Message.PollVoteMessage.decode(decrypted);
}

export function matchPollOptions(selectedHashes: Uint8Array[], storedPoll: StoredPoll): string[] {
  const optionMap = new Map<string, string>();
  for (const opt of storedPoll.options) {
    const hash = crypto.createHash("sha256").update(opt).digest("hex");
    optionMap.set(hash, opt);
  }
  const matched: string[] = [];
  for (const hash of selectedHashes) {
    const hex = Buffer.from(hash).toString("hex");
    const name = optionMap.get(hex);
    if (name) matched.push(name);
  }
  return matched;
}
