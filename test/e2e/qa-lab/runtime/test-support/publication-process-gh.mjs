#!/usr/bin/env node
// Native gh external-I/O fixture. No installed identity or live-service fallback.
import fs from "node:fs/promises";
const config = JSON.parse(await fs.readFile(new URL(process.argv[2]), "utf8"));
const args = process.argv.slice(3);
if (args[0] !== "api" || args[args.indexOf("--hostname") + 1] !== "github.com") {
  throw new Error("Unexpected synthetic gh invocation");
}
const method = args[args.indexOf("--method") + 1];
const endpoint = args[args.indexOf("--method") + 2];
if (!(endpoint === "graphql" || endpoint.startsWith("repos/example/setup-proof"))) {
  throw new Error("Synthetic gh target refused");
}
const base = new URL(config.endpoint);
if (base.protocol !== "https:" || base.hostname !== "127.0.0.1") {
  throw new Error("Synthetic gh requires loopback TLS");
}
const url = new URL(endpoint, base);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-f") {
    const [key, ...value] = args[++i].split("=");
    url.searchParams.set(key, value.join("="));
  }
}
let body;
if (method !== "GET") {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  body = Buffer.concat(chunks);
}
const response = await fetch(url, {
  method,
  headers: {
    authorization: `Bearer ${process.env.GH_TOKEN ?? ""}`,
    "content-type": "application/json",
  },
  ...(body ? { body } : {}),
});
const text = await response.text();
if (!response.ok) {
  process.stderr.write(`synthetic GitHub transport (HTTP ${response.status})\n`);
  process.exitCode = 1;
} else {
  let value = JSON.parse(text);
  const jq = args[args.indexOf("--jq") + 1];
  if (args.includes("--jq") && jq === "{sha: .merge_base_commit.sha}") {
    value = { sha: value.merge_base_commit.sha };
  } else if (args.includes("--jq") && jq.startsWith("map({url:")) {
    value = value.map((p) => ({
      url: p.html_url,
      userId: p.user.id,
      state: p.state,
      body: p.body,
      headSha: p.head.sha,
      headRef: p.head.ref,
      baseRef: p.base.ref,
    }));
  } else if (args.includes("--jq")) {
    throw new Error("Unsupported fixture projection");
  }
  process.stdout.write(JSON.stringify(value) + "\n");
}
