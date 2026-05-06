import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeRuntimeJson, type OutputRuntimeEnv } from "../runtime.js";

export type FeatureLabStatusParams = {
  json?: boolean;
  root?: string;
};

type FeatureLabStatus = {
  root: string;
  source: string;
  install: string;
  deployedSha: string | null;
  serviceFile: string;
  serviceUsesFeatureInstall: boolean;
  serviceCommand: string | null;
};

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function readTrimmed(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function readServiceCommand(serviceText: string): string | null {
  const line = serviceText.split(/\r?\n/).find((entry) => entry.startsWith("ExecStart="));
  return line ? line.slice("ExecStart=".length).trim() : null;
}

export function getFeatureLabStatus(params: FeatureLabStatusParams = {}): FeatureLabStatus {
  const root = expandHome(
    params.root || process.env.OPENCLAW_FEATURE_LAB_ROOT || "~/openclaw-feature-lab",
  );
  const source = path.join(root, "openclaw");
  const install =
    process.env.OPENCLAW_FEATURE_INSTALL_DIR || path.join(os.homedir(), "openclaw-feature-install");
  const serviceFile = path.join(os.homedir(), ".config/systemd/user/openclaw-gateway.service");
  const serviceText = readTrimmed(serviceFile) || "";
  const serviceCommand = readServiceCommand(serviceText);
  return {
    root,
    source,
    install,
    deployedSha: readTrimmed(path.join(root, "last-deployed-openclaw-sha.txt")),
    serviceFile,
    serviceUsesFeatureInstall: serviceText.includes(path.join(install, "dist/index.js")),
    serviceCommand,
  };
}

export async function featureLabStatusCommand(
  params: FeatureLabStatusParams,
  runtime: OutputRuntimeEnv,
): Promise<void> {
  const status = getFeatureLabStatus(params);
  if (params.json) {
    writeRuntimeJson(runtime, status);
    return;
  }
  runtime.writeStdout("OpenClaw Feature Lab");
  runtime.writeStdout(`Root: ${status.root}`);
  runtime.writeStdout(`Source: ${status.source}`);
  runtime.writeStdout(`Install: ${status.install}`);
  runtime.writeStdout(`Deployed SHA: ${status.deployedSha ?? "none"}`);
  runtime.writeStdout(`Service file: ${status.serviceFile}`);
  runtime.writeStdout(
    `Service uses feature install: ${status.serviceUsesFeatureInstall ? "yes" : "no"}`,
  );
  if (status.serviceCommand) {
    runtime.writeStdout(`Service command: ${status.serviceCommand}`);
  }
}
