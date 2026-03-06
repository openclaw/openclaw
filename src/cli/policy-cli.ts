import fs from "node:fs/promises";
import type { Command } from "commander";
import { canonicalizePolicyJson } from "../policy/policy.canonical.js";
import { signEd25519Payload, verifyEd25519Signature } from "../policy/policy.crypto.js";
import { SignedPolicySchema } from "../policy/policy.schema.js";
import { defaultRuntime } from "../runtime.js";

function trimOrThrow(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is required`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

async function readKeyFile(keyPath: string): Promise<string> {
  const key = await fs.readFile(keyPath, "utf8");
  const trimmed = key.trim();
  if (!trimmed) {
    throw new Error(`Key file is empty: ${keyPath}`);
  }
  return trimmed;
}

function parseAndCanonicalizePolicy(rawPolicy: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPolicy);
  } catch (err) {
    throw new Error(`Policy JSON parse failed: ${String(err)}`, { cause: err });
  }
  const validated = SignedPolicySchema.safeParse(parsed);
  if (!validated.success) {
    const issueText = validated.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Policy schema validation failed: ${issueText}`);
  }
  return canonicalizePolicyJson(validated.data);
}

export function registerPolicyCli(program: Command) {
  const policy = program.command("policy").description("Sign and verify signed policy guardrails");

  policy
    .command("sign")
    .description("Sign POLICY.json with an ed25519 private key")
    .requiredOption("--in <path>", "Path to POLICY.json")
    .requiredOption("--out <path>", "Output signature path")
    .requiredOption("--private-key <path>", "Path to private key file (base64 or PEM)")
    .action(async (opts: Record<string, unknown>) => {
      const inputPath = trimOrThrow(opts["in"], "--in");
      const outputPath = trimOrThrow(opts["out"], "--out");
      const privateKeyPath = trimOrThrow(opts["privateKey"], "--private-key");

      const payload = parseAndCanonicalizePolicy(await fs.readFile(inputPath, "utf8"));
      const privateKey = await readKeyFile(privateKeyPath);
      const signature = signEd25519Payload({ payload, privateKey });
      await fs.writeFile(outputPath, `${signature}\n`, "utf8");
      defaultRuntime.log(`Policy signed: ${outputPath}`);
    });

  policy
    .command("verify")
    .description("Verify POLICY.json + POLICY.sig with an ed25519 public key")
    .requiredOption("--in <path>", "Path to POLICY.json")
    .requiredOption("--sig <path>", "Path to POLICY.sig")
    .requiredOption("--public-key <base64>", "Base64 ed25519 public key")
    .action(async (opts: Record<string, unknown>) => {
      const inputPath = trimOrThrow(opts["in"], "--in");
      const sigPath = trimOrThrow(opts["sig"], "--sig");
      const publicKey = trimOrThrow(opts["publicKey"], "--public-key");

      const payload = parseAndCanonicalizePolicy(await fs.readFile(inputPath, "utf8"));
      const signature = (await fs.readFile(sigPath, "utf8")).trim();
      const valid = verifyEd25519Signature({
        payload,
        signatureBase64: signature,
        publicKey,
      });
      if (!valid) {
        defaultRuntime.error("Policy signature verification failed.");
        defaultRuntime.exit(1);
      }
      defaultRuntime.log("Policy signature is valid.");
    });
}
