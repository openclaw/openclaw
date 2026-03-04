import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig, readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import { applyMergePatch } from "../config/merge-patch.js";
import {
  DEFAULT_PATTERNS,
  type PatternDefinition,
} from "../hooks/bundled/pattern-detector/handler.js";
import { resolveHookConfig } from "../hooks/config.js";
import { isLocalDirectRequest } from "./auth.js";
import { sendJson } from "./http-common.js";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export async function handlePatternsGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isLocalDirectRequest(req, [])) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }
  const cfg = loadConfig();
  const hookEntry = resolveHookConfig(cfg, "pattern-detector");
  const patterns = Array.isArray(hookEntry?.patterns) ? hookEntry.patterns : DEFAULT_PATTERNS;
  const enabled = hookEntry?.enabled !== false;
  sendJson(res, 200, { enabled, patterns });
}

export async function handlePatternsPut(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isLocalDirectRequest(req, [])) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  try {
    const body = JSON.parse(await readBody(req)) as {
      enabled?: boolean;
      patterns?: PatternDefinition[];
    };

    // Validate each regex
    if (body.patterns) {
      for (const p of body.patterns) {
        try {
          new RegExp(p.regex, p.flags ?? "g");
        } catch (err) {
          sendJson(res, 400, { error: `Invalid regex in pattern "${p.id}": ${String(err)}` });
          return;
        }
      }
    }

    const snapshot = await readConfigFileSnapshot();
    const merged = applyMergePatch(snapshot.config, {
      hooks: {
        internal: {
          entries: {
            "pattern-detector": {
              enabled: body.enabled ?? true,
              ...(body.patterns ? { patterns: body.patterns } : {}),
            },
          },
        },
      },
    });
    await writeConfigFile(merged as Record<string, unknown>);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 500, { error: String(err) });
  }
}

export async function handlePatternsTest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isLocalDirectRequest(req, [])) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  try {
    const body = JSON.parse(await readBody(req)) as {
      text: string;
      patterns: PatternDefinition[];
    };

    const results: { id: string; label: string; matches: string[] }[] = [];

    for (const p of body.patterns) {
      if (!p.enabled) {
        continue;
      }
      try {
        const re = new RegExp(p.regex, p.flags ?? "g");
        const matches: string[] = [];
        let match: RegExpExecArray | null;
        let count = 0;
        while ((match = re.exec(body.text)) !== null && count < 20) {
          if (match[0].length === 0) {
            re.lastIndex++;
            continue;
          }
          matches.push(match[0]);
          count++;
          if (!re.flags.includes("g")) {
            break;
          }
        }
        if (matches.length > 0) {
          results.push({ id: p.id, label: p.label, matches });
        }
      } catch {
        // Skip invalid regex
      }
    }

    sendJson(res, 200, { results });
  } catch (err) {
    sendJson(res, 500, { error: String(err) });
  }
}
