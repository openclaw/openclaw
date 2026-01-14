export type RelaySmokeTest = "qr";

export function parseRelaySmokeTest(args: string[], env: NodeJS.ProcessEnv): RelaySmokeTest | null {
  const smokeIdx = args.indexOf("--smoke");
  if (smokeIdx !== -1) {
    const value = args[smokeIdx + 1];
    if (!value || value.startsWith("-")) {
      throw new Error("Missing value for --smoke (expected: qr)");
    }
    if (value === "qr") return "qr";
    throw new Error(`Unknown smoke test: ${value}`);
  }

  if (args.includes("--smoke-qr")) return "qr";

  // Back-compat: only run env-based smoke mode when no CLI args are present,
  // to avoid surprising early-exit when users set env vars globally.
  if (args.length === 0 && (env.CLAWDBOT_SMOKE_QR === "1" || env.CLAWDBOT_SMOKE === "qr")) {
    return "qr";
  }

  return null;
}

export async function runRelaySmokeTest(test: RelaySmokeTest): Promise<void> {
  switch (test) {
    case "qr": {
      const { renderQrPngBase64 } = await import("../web/qr-image.js");
      await renderQrPngBase64("smoke-test");
      return;
    }
  }
}
