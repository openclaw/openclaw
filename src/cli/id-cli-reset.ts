// `openclaw id reset`: Reset owner access on this machine (OpenClaw ID owner reset,
// enrollment.md "Owner reset"). It routes to the Gateway when one runs; with the Gateway
// stopped it edits the local claw record under the Gateway lock, which is why it uses the
// local state owner instead of a Gateway URL. The new recovery kit is made here, signs the
// new binding and is printed once; it never reaches the Gateway, argv, JSON output or logs.
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
import type { OpenClawConfig } from "../config/types.js";
import type { AuthorityRefusal } from "../gateway/openclaw-id/authority-result.js";
import type {
  ResetCommit,
  ResetPreparation,
  ResetRemoved,
} from "../gateway/openclaw-id/reset-operations.js";
import { isOpenClawIdEnabled } from "../shared/openclaw-id-policy.js";
import { throwExpectedCliError } from "./expected-cli-error.js";
import { runWithLocalStateOwner } from "./local-state-owner.js";
import { promptText } from "./prompt.js";

/** What a committed reset reports, from the Gateway or the offline path. */
type ResetResult = {
  bindingSeq: number;
  removed: ResetRemoved;
  /** Discovery's answer when the Gateway published right away; absent offline. */
  publication?: { state?: string; code?: string } | null;
};

const TARGET = "OpenClaw ID owner access";

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

// The local path needs the Lab on, like the Gateway's.
function requireEnabled(config: OpenClawConfig) {
  if (!isOpenClawIdEnabled(config.gateway?.openclawId)) {
    throwExpectedCliError("OpenClaw ID is off on this computer (Settings → Labs).");
  }
}

function unwrap<T extends object>(result: T | AuthorityRefusal): T {
  if ("ok" in result && result.ok === false) {
    return throwExpectedCliError(`Owner access was not reset: ${result.detail} (${result.code}).`);
  }
  return result as T;
}

async function offlineAuthority(config: OpenClawConfig) {
  requireEnabled(config);
  const { createOpenClawIdAuthority } = await import("../gateway/openclaw-id/authority.js");
  return createOpenClawIdAuthority();
}

async function prepare(): Promise<ResetPreparation> {
  return unwrap(
    await runWithLocalStateOwner<ResetPreparation | AuthorityRefusal>({
      method: "openclawId.authority",
      params: { action: "reset_prepare" },
      target: TARGET,
      runLocal: async ({ config }) => await (await offlineAuthority(config)).prepareReset(),
    }),
  );
}

async function commit(input: ResetCommit): Promise<ResetResult> {
  return unwrap(
    await runWithLocalStateOwner<ResetResult | AuthorityRefusal>({
      method: "openclawId.authority",
      params: { action: "reset_commit", rootPub: input.root_pub, binding: input.binding },
      target: TARGET,
      recoveryCommand: "openclaw id status",
      runLocal: async ({ config, env, assertCurrent }) => {
        const authority = await offlineAuthority(config);
        const bound = (await authority.load())?.binding?.body.k_gw;
        if (!bound) {
          return { ok: false, code: "not_linked", detail: "this claw is not linked" };
        }
        const [{ loadGatewaySigner }, { resolveStateDir }] = await Promise.all([
          import("../gateway/openclaw-id/gateway-key.js"),
          import("../config/paths.js"),
        ]);
        // The key rule: only the K_gw the binding names signs the RootReset; nothing is created.
        const { signer } = await loadGatewaySigner(resolveStateDir(env), bound);
        // Token revocation, node pairings and publication follow at the Gateway's next start.
        return await authority.commitReset(input, "local_operator", signer, assertCurrent);
      },
    }),
  );
}

function publicationLine(result: ResetResult): string {
  if (result.publication === undefined) {
    return "The Gateway publishes the new owner key to Discovery when it starts.";
  }
  if (result.publication?.state === "published") {
    return "Discovery has the new owner key.";
  }
  return `Discovery doesn't have the new owner key yet${result.publication?.code ? ` (${result.publication.code})` : ""}; the Gateway keeps publishing it (openclaw id status).`;
}

/** Runs the reset: confirm by name, make the kit, commit, then show the kit once. */
export async function runReset(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throwExpectedCliError(
      "openclaw id reset shows a new recovery kit once, so it runs only in an interactive terminal.",
    );
  }
  const prep = await prepare();
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
  const kitLines = [
    "",
    "New recovery kit. It is shown only now and is not stored on this computer:",
    `  Recovery code:   ${kit}`,
    `  Recovery kit ID: ${displayFingerprint(await fingerprint(rootPub))}`,
    "Anyone with this kit can control this claw. Save it somewhere safe.",
  ];
  let result: ResetResult;
  try {
    result = await commit({ root_pub: rootPub, binding });
  } catch (error) {
    // The reset may have been stored: this kit is then the only way back in for owners.
    if ((error as { code?: unknown }).code === "OUTCOME_UNKNOWN") {
      process.stdout.write(
        `${["The reset may have been applied. Keep this kit until openclaw id status shows which owner key the claw has.", ...kitLines].join("\n")}\n`,
      );
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  const { ownerDevices, members, nodes, invites } = result.removed;
  process.stdout.write(
    `${[
      "Owner access reset.",
      `Removed ${ownerDevices} owner device(s), ${members} person(s), ${nodes} node(s) and ${invites} invite(s).`,
      publicationLine(result),
      ...kitLines,
      "",
      "Set up your browsers again with this kit: open the claw's address and choose Use a recovery kit.",
    ].join("\n")}\n`,
  );
}
