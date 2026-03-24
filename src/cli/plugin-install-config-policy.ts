import path from "node:path";
import type { Command } from "commander";
import { resolveUserPath } from "../utils.js";
import { resolveFileNpmSpecToLocalPath } from "./plugins-command-helpers.js";

export type PluginInstallInvalidConfigPolicy = "deny" | "recover-matrix-only";

export type PluginInstallRequestContext = {
  rawSpec: string;
  normalizedSpec: string;
  resolvedPath?: string;
  marketplace?: string;
};

type PluginInstallRequestResolution =
  | { ok: true; request: PluginInstallRequestContext }
  | { ok: false; error: string };

function isPluginInstallCommand(commandPath: string[]): boolean {
  return commandPath[0] === "plugins" && commandPath[1] === "install";
}

function isExplicitMatrixInstallRequest(request: PluginInstallRequestContext): boolean {
  if (request.marketplace) {
    return false;
  }
  const candidates = [request.rawSpec.trim(), request.normalizedSpec.trim()];
  if (candidates.includes("@openclaw/matrix")) {
    return true;
  }
  if (!request.resolvedPath) {
    return false;
  }
  return (
    path.basename(request.resolvedPath) === "matrix" &&
    path.basename(path.dirname(request.resolvedPath)) === "extensions"
  );
}

function resolvePluginInstallArgvTokens(commandPath: string[], argv: string[]): string[] {
  const args = argv.slice(2);
  let cursor = 0;
  for (const segment of commandPath) {
    while (cursor < args.length && args[cursor] !== segment) {
      cursor += 1;
    }
    if (cursor >= args.length) {
      return [];
    }
    cursor += 1;
  }
  return args.slice(cursor);
}

function resolvePluginInstallArgvRequest(commandPath: string[], argv: string[]) {
  if (!isPluginInstallCommand(commandPath)) {
    return null;
  }
  const tokens = resolvePluginInstallArgvTokens(commandPath, argv);
  let rawSpec: string | null = null;
  let marketplace: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith("--marketplace=")) {
      marketplace = token.slice("--marketplace=".length);
      continue;
    }
    if (token === "--marketplace") {
      const value = tokens[index + 1];
      if (typeof value === "string") {
        marketplace = value;
        index += 1;
      }
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    rawSpec ??= token;
  }
  return rawSpec ? { rawSpec, marketplace } : null;
}

export function resolvePluginInstallRequestContext(params: {
  rawSpec: string;
  marketplace?: string;
}): PluginInstallRequestResolution {
  if (params.marketplace) {
    return {
      ok: true,
      request: {
        rawSpec: params.rawSpec,
        normalizedSpec: params.rawSpec,
        marketplace: params.marketplace,
      },
    };
  }
  const fileSpec = resolveFileNpmSpecToLocalPath(params.rawSpec);
  if (fileSpec && !fileSpec.ok) {
    return {
      ok: false,
      error: fileSpec.error,
    };
  }
  const normalizedSpec = fileSpec && fileSpec.ok ? fileSpec.path : params.rawSpec;
  return {
    ok: true,
    request: {
      rawSpec: params.rawSpec,
      normalizedSpec,
      resolvedPath: resolveUserPath(normalizedSpec),
    },
  };
}

export function resolvePluginInstallPreactionRequest(params: {
  actionCommand: Command;
  commandPath: string[];
  argv: string[];
}): PluginInstallRequestContext | null {
  if (!isPluginInstallCommand(params.commandPath)) {
    return null;
  }
  const argvRequest = resolvePluginInstallArgvRequest(params.commandPath, params.argv);
  const opts = params.actionCommand.opts<Record<string, unknown>>();
  const marketplace =
    (typeof opts.marketplace === "string" && opts.marketplace.trim()
      ? opts.marketplace
      : argvRequest?.marketplace) || undefined;
  const rawSpec =
    (typeof params.actionCommand.processedArgs?.[0] === "string"
      ? params.actionCommand.processedArgs[0]
      : argvRequest?.rawSpec) ?? null;
  if (!rawSpec) {
    return null;
  }
  const request = resolvePluginInstallRequestContext({ rawSpec, marketplace });
  return request.ok ? request.request : null;
}

export function resolvePluginInstallInvalidConfigPolicy(
  request: PluginInstallRequestContext | null,
): PluginInstallInvalidConfigPolicy {
  if (!request) {
    return "deny";
  }
  return isExplicitMatrixInstallRequest(request) ? "recover-matrix-only" : "deny";
}
