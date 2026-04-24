/**
 * Thin HTTP shim that wraps the gemma.cpp CLI binary with an
 * OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Launched as a child process by the gemma.cpp RuntimeManager.
 * Not intended for production use; this exists so that the rest of the
 * gemmaclaw codebase can talk to gemma.cpp through the same OpenAI-compat
 * provider path used by Ollama and llama.cpp.
 */

import { spawn } from "node:child_process";
import http from "node:http";

type ChatMessage = { role: string; content: string };
type ChatRequest = { model?: string; messages: ChatMessage[]; max_tokens?: number };

function formatPrompt(messages: ChatMessage[]): string {
  // Format as a simple turn-based prompt.
  return (
    messages
      .map((m) => {
        if (m.role === "system") {
          return `<start_of_turn>user\n${m.content}<end_of_turn>`;
        }
        if (m.role === "user") {
          return `<start_of_turn>user\n${m.content}<end_of_turn>`;
        }
        return `<start_of_turn>model\n${m.content}<end_of_turn>`;
      })
      .join("\n") + "\n<start_of_turn>model\n"
  );
}

function runGemma(
  binaryPath: string,
  modelPath: string,
  tokenizerPath: string,
  prompt: string,
  maxTokens: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      `--model=${modelPath}`,
      `--tokenizer=${tokenizerPath}`,
      `--max_tokens=${maxTokens}`,
    ];

    const child = spawn(binaryPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.stdin.write(prompt);
    child.stdin.end();

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`gemma exited with code ${code}: ${stderr}`));
        return;
      }
      // Strip the echoed prompt from output if present.
      const cleaned = stdout.replace(prompt, "").trim();
      resolve(cleaned);
    });
  });
}

export function startGemmaCppShim(opts: {
  binaryPath: string;
  modelPath: string;
  tokenizerPath: string;
  port: number;
  host?: string;
}): http.Server {
  const server = http.createServer(async (req, res) => {
    // Health endpoint.
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // OpenAI-compat chat completions.
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body) as ChatRequest;
          const prompt = formatPrompt(parsed.messages);
          const maxTokens = parsed.max_tokens ?? 128;

          const content = await runGemma(
            opts.binaryPath,
            opts.modelPath,
            opts.tokenizerPath,
            prompt,
            maxTokens,
          );

          const response = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: parsed.model ?? "gemma-cpp",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          };

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message, type: "server_error" } }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(opts.port, opts.host ?? "127.0.0.1");
  return server;
}

// When run directly as a script (for the RuntimeManager to spawn):
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const args = process.argv.slice(2);
  const get = (flag: string): string => {
    const idx = args.indexOf(flag);
    if (idx === -1 || idx + 1 >= args.length) {
      throw new Error(`Missing ${flag}`);
    }
    return args[idx + 1];
  };

  const server = startGemmaCppShim({
    binaryPath: get("--binary"),
    modelPath: get("--model"),
    tokenizerPath: get("--tokenizer"),
    port: Number(get("--port")),
  });

  server.on("listening", () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : "?";
    console.log(`gemma.cpp shim listening on port ${port}`);
  });
}
