// `openclaw id reset`: Reset owner access on this machine (OpenClaw ID owner reset,
// enrollment.md "Owner reset"). It needs this machine's running Gateway over a direct
// connection and a link code from the OpenClaw ID account that owns the claw; the Gateway
// checks the code with Discovery before anything changes. The new recovery kit is made here,
// signs the new binding and is printed once; it never reaches the Gateway, argv, JSON output
// or logs.
import {
  deriveRootSigner,
  displayFingerprint,
  encodeKit,
  fingerprint,
  formatEd25519PublicKey,
  generateKitSecret,
  ROOT_EPOCH,
  signStatement,
} from "../../packages/openclaw-id-protocol/src/index.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { ResetPreparation, ResetRemoved } from "../gateway/openclaw-id/reset-operations.js";
import { throwExpectedCliError } from "./expected-cli-error.js";
import { callGatewayFromCli, type GatewayRpcOpts } from "./gateway-rpc.js";
import { promptText } from "./prompt.js";

/** What a committed reset reports, from the Gateway or the offline path. */
type ResetResult = {
  bindingSeq: number;
  removed: ResetRemoved;
  /** Discovery's answer to the Gateway's publication; null when it couldn't be read. */
  publication: { state?: string; code?: string } | null;
  /** A step after the stored reset failed. */
  followUpError?: string;
};

/** The name the owner picked when linking: the hostname's first label without the account tag. */
export function clawShortName(hostname: string): string {
  return (hostname.split(".")[0] ?? hostname).replace(/-[0-9a-z]{5}$/, "");
}

/** What the operator confirms before anything is signed. */
export function describeReset(prep: ResetPreparation): string {
  const { ownerDevices, members, nodes, invites } = prep.removes;
  return [
    `Reset owner access to ${sanitizeTerminalText(prep.hostname)}?`,
    "This makes a new recovery kit and removes everyone who can reach this claw remotely:",
    `  ${ownerDevices} owner device(s), ${members} person(s), ${nodes} node(s) and ${invites} invite(s).`,
    "Remote sessions close and their sign-ins stop working. Access on this computer, the claw's",
    "address and all of its data stay. Your old recovery kit stops working.",
  ].join("\n");
}

export type ResetOpts = GatewayRpcOpts & { code?: string };

const authority = (opts: ResetOpts, params: Record<string, unknown>) =>
  callGatewayFromCli("openclawId.authority", opts, params, { scopes: ["operator.admin"] });

function publicationLine(result: ResetResult): string {
  if (result.publication?.state === "published") {
    return "Discovery has the new owner key.";
  }
  return `Discovery doesn't have the new owner key yet${result.publication?.code ? ` (${result.publication.code})` : ""}; the Gateway keeps publishing it (openclaw id status).`;
}

/**
 * Runs the reset: check the owner account's code and confirm by name, make the kit and show it,
 * and commit only after the operator says it is saved, so a lost answer never loses the kit.
 */
export async function runReset(opts: ResetOpts, readCode: () => Promise<string>): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throwExpectedCliError(
      "openclaw id reset shows a new recovery kit once, so it runs only in an interactive terminal.",
    );
  }
  const code = await readCode();
  // SAFETY: reset_prepare answers with ResetPreparation (reset-operations.ts).
  const prep = (await authority(opts, { action: "reset_prepare", code })) as ResetPreparation;
  const name = clawShortName(prep.hostname);
  process.stdout.write(`${describeReset(prep)}\n`);
  const typed = (
    await promptText(`Type the claw's name (${sanitizeTerminalText(name)}) to reset: `)
  ).trim();
  if (typed !== name) {
    process.stdout.write("Not reset.\n");
    return;
  }
  const secret = generateKitSecret();
  const root = await deriveRootSigner(secret);
  const kit = await encodeKit(secret);
  secret.fill(0);
  const rootPub = formatEd25519PublicKey(root.publicKey);
  const binding = await signStatement(
    "ServerBinding",
    {
      claw_id: prep.claw_id,
      hostname: prep.hostname,
      k_srv: prep.k_srv,
      k_gw: prep.k_gw,
      binding_seq: prep.binding_seq,
      root_epoch: ROOT_EPOCH,
      issued_at: Math.floor(Date.now() / 1000),
    },
    root,
  );
  process.stdout.write(
    `${[
      "",
      "New recovery kit. It is shown only now and is not stored on this computer:",
      `  Recovery code:   ${kit}`,
      `  Recovery kit ID: ${displayFingerprint(await fingerprint(rootPub))}`,
      "Anyone with this kit can control this claw. Save it somewhere safe.",
      "",
    ].join("\n")}\n`,
  );
  const saved = (await promptText('Type "saved" once the kit is saved to reset owner access: '))
    .trim()
    .toLowerCase();
  if (saved !== "saved") {
    process.stdout.write("Not reset. Discard the kit above; it was never used.\n");
    return;
  }
  let result: ResetResult;
  try {
    // SAFETY: reset_commit answers with ResetCommitResult (service-reset.ts).
    result = (await authority(opts, {
      action: "reset_commit",
      rootPub,
      binding,
      code,
    })) as ResetResult;
  } catch (error) {
    // Only the reset handler's own refusals carry a code, and they precede any change. Anything
    // else (a dropped connection, a timeout, a dispatcher error) may follow a stored reset.
    if (typeof (error as { details?: { code?: unknown } }).details?.code === "string") {
      process.stdout.write("Not reset. Discard the kit above; it was never used.\n");
      throw error;
    }
    process.stdout.write(
      "The reset may have been applied. Keep the kit above until openclaw id status shows which owner key the claw has.\n",
    );
    process.exitCode = 2;
    return;
  }
  const { ownerDevices, members, nodes, invites } = result.removed;
  process.stdout.write(
    `${[
      "Owner access reset.",
      `Removed ${ownerDevices} owner device(s), ${members} person(s), ${nodes} node(s) and ${invites} invite(s).`,
      result.followUpError
        ? `A step after the reset failed (${sanitizeTerminalText(result.followUpError)}); run openclaw id status.`
        : publicationLine(result),
      "Set up your browsers again with the kit above: open the claw's address and choose Use a recovery kit.",
    ].join("\n")}\n`,
  );
  if (result.followUpError) {
    process.exitCode = 2;
  }
}
