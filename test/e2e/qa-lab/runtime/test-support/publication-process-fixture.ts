import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:https";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  closeHttpServer,
  listenLoopback,
  readRequestText,
  respondJson,
} from "../../../../helpers/gateway-integration-fixtures.js";
import { command } from "./managed-setup-fixtures.test-support.js";
import {
  SETUP_PROOF_GITHUB_TOKEN,
  SETUP_PROOF_REMOTE,
} from "./setup-repository-integration/api.js";

// All external facts are synthetic. Objects, ancestry and CAS are native Git.
export async function publicationProcessFixture(root: string, repository: string) {
  const key = path.join(root, "publication.key");
  const cert = path.join(root, "publication.crt");
  await command([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-days",
    "1",
  ]);
  const run = promisify(execFile);
  const git = async (args: string[], input?: Buffer | string, env?: NodeJS.ProcessEnv) => {
    const child = execFile("/usr/bin/git", ["-C", repository, ...args], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (input !== undefined) {
      child.stdin!.end(input);
    } else {
      child.stdin!.end();
    }
    return await new Promise<string>((resolve, reject) => {
      let out = "";
      let err = "";
      child.stdout!.on("data", (c) => (out += c));
      child.stderr!.on("data", (c) => (err += c));
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve(out.trimEnd()) : reject(new Error(`fixture Git ${args[0]}: ${err}`)),
      );
    });
  };
  const head = await git(["rev-parse", "HEAD"]);
  const baseTree = await git(["rev-parse", "HEAD^{tree}"]);
  const metadata = {
    id: 7,
    node_id: "R_setup_fixture",
    name: "setup-proof",
    full_name: "example/setup-proof",
    clone_url: SETUP_PROOF_REMOTE,
    private: false,
    default_branch: "main",
    owner: { login: "example" },
    permissions: { pull: true, push: true, admin: true },
  };
  let unavailable = true;
  let physicalCas = 0;
  let reads = 0;
  let requests = 0;
  let objectWrites = 0;
  const pulls: Array<{
    html_url: string;
    number: number;
    user: { id: number };
    state: string;
    body: string;
    head: { sha: string; ref: string; repo: typeof metadata };
    base: { ref: string; repo: typeof metadata };
  }> = [];
  const commit = async (sha: string) => ({
    sha,
    tree: { sha: await git(["rev-parse", `${sha}^{tree}`]) },
    parents: (await git(["show", "-s", "--format=%P", sha]))
      .split(" ")
      .filter(Boolean)
      .map((parentSha) => ({ sha: parentSha })),
    message: await git(["show", "-s", "--format=%B", sha]),
  });
  const server = createServer(
    { key: await fs.readFile(key), cert: await fs.readFile(cert) },
    (incoming, response) => {
      void (async () => {
        requests++;
        if (incoming.headers.authorization !== `Bearer ${SETUP_PROOF_GITHUB_TOKEN}`) {
          respondJson(response, {}, 401);
          return;
        }
        response.setHeader("x-oauth-scopes", "repo, read:org");
        const url = new URL(incoming.url ?? "/", "https://api.github.com");
        const route = decodeURIComponent(url.pathname);
        const post = incoming.method === "POST";
        const body = post ? JSON.parse(await readRequestText(incoming)) : undefined;
        let value: unknown;
        if (route === "/user") {
          reads++;
          value = { id: 4243, login: "setup-fixture", type: "User", avatar_url: null };
        } else if (route === "/graphql") {
          if (body.variables?.input?.refUpdates) {
            const input = body.variables.input;
            assert.equal(input.repositoryId, metadata.node_id);
            assert.equal(input.refUpdates.length, 1);
            const update = input.refUpdates[0];
            assert.equal(update.force, false);
            assert.match(update.name, /^refs\/heads\//);
            await git(["update-ref", update.name, update.afterOid, update.beforeOid]);
            physicalCas++;
            value = { data: { updateRefs: { clientMutationId: input.clientMutationId } } };
          } else {
            value = {
              data: {
                node: {
                  ...metadata,
                  __typename: "Repository",
                  object: { __typename: "Commit", sha: head, tree: { sha: baseTree } },
                },
              },
            };
          }
        } else if (route === "/repos/example/setup-proof") {
          value = metadata;
        } else if (route.startsWith("/repos/example/setup-proof/commits/")) {
          value = { sha: head, commit: { tree: { sha: baseTree } } };
        } else if (route.startsWith("/repos/example/setup-proof/compare/")) {
          const [a, b] = route.split("/compare/")[1]!.split("...");
          value = { merge_base_commit: { sha: await git(["merge-base", a!, b!]) } };
        } else if (route.startsWith("/repos/example/setup-proof/git/ref/heads/")) {
          const ref = route.split("/git/ref/")[1]!;
          value = { ref: "refs/" + ref, object: { sha: await git(["rev-parse", "refs/" + ref]) } };
        } else if (route.startsWith("/repos/example/setup-proof/git/matching-refs/heads/")) {
          const ref = "refs/" + route.split("/matching-refs/")[1]!;
          const sha = await git(["for-each-ref", "--format=%(objectname)", ref]);
          value = sha ? [{ ref, object: { sha } }] : [];
        } else if (route === "/repos/example/setup-proof/pulls") {
          if (post) {
            const branch = body.head.split(":")[1];
            const pr = {
              html_url: "https://github.com/example/setup-proof/pull/1",
              number: 1,
              user: { id: 4243 },
              state: "open",
              body: body.body,
              head: {
                sha: await git(["rev-parse", "refs/heads/" + branch]),
                ref: branch,
                repo: metadata,
              },
              base: { ref: body.base, repo: metadata },
            };
            pulls.push(pr);
            value = pr;
          } else {
            value = pulls;
          }
        } else if (route === "/repos/example/setup-proof/pulls/1") {
          value = pulls[0];
        } else {
          const match =
            /^\/repos\/example\/setup-proof\/git\/(commits|trees|blobs)(?:\/([a-f0-9]{40}))?$/.exec(
              route,
            );
          if (!match) {
            respondJson(response, { message: "fixture endpoint not implemented" }, 404);
            return;
          }
          const kind = match[1];
          const sha = match[2];
          if (post) {
            if (kind === "blobs") {
              if (unavailable) {
                respondJson(response, { message: "pre-effect fixture outage" }, 503);
                return;
              }
              value = {
                sha: await git(
                  ["hash-object", "-w", "--stdin"],
                  Buffer.from(body.content, body.encoding),
                ),
              };
            } else if (kind === "trees") {
              const index = path.join(root, `index-${objectWrites}`);
              const env = { GIT_INDEX_FILE: index };
              await git(["read-tree", body.base_tree], undefined, env);
              for (const entry of body.tree) {
                if (entry.sha === null) {
                  await git(["update-index", "--force-remove", "--", entry.path], undefined, env);
                } else {
                  await git(
                    ["update-index", "--add", "--cacheinfo", entry.mode, entry.sha, entry.path],
                    undefined,
                    env,
                  );
                }
              }
              value = { sha: await git(["write-tree"], undefined, env) };
              await fs.rm(index, { force: true });
            } else {
              const author = body.author;
              const createdSha = await git(
                [
                  "commit-tree",
                  body.tree,
                  ...body.parents.flatMap((parent: string) => ["-p", parent]),
                ],
                body.message,
                {
                  GIT_AUTHOR_NAME: author.name,
                  GIT_AUTHOR_EMAIL: author.email,
                  GIT_AUTHOR_DATE: author.date,
                  GIT_COMMITTER_NAME: author.name,
                  GIT_COMMITTER_EMAIL: author.email,
                  GIT_COMMITTER_DATE: author.date,
                },
              );
              value = await commit(createdSha);
            }
            objectWrites++;
          } else if (kind === "commits") {
            value = await commit(sha!);
          } else if (kind === "trees") {
            value = {
              sha,
              truncated: false,
              tree: (await git(["ls-tree", "-z", sha!]))
                .split("\0")
                .filter(Boolean)
                .map((line) => {
                  const [header, name] = line.split("\t");
                  const [mode, type, entrySha] = header!.split(" ");
                  return { mode, type, sha: entrySha, path: name };
                }),
            };
          } else {
            const { stdout } = await run(
              "/usr/bin/git",
              ["-C", repository, "cat-file", "blob", sha!],
              { encoding: "buffer" },
            );
            value = {
              sha,
              size: stdout.length,
              encoding: "base64",
              content: stdout.toString("base64"),
            };
          }
        }
        respondJson(response, value);
      })().catch((error: unknown) => {
        console.error("PUBLICATION_EXTERNAL_FIXTURE", String(error));
        if (!response.headersSent) {
          respondJson(response, {}, 500);
        } else {
          response.end();
        }
      });
    },
  );
  const endpoint = await listenLoopback(server, "https");
  const config = path.join(root, "gh-transport.json");
  await fs.writeFile(config, JSON.stringify({ endpoint: endpoint + "/" }));
  const bin = path.join(root, "bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(
    path.join(bin, "gh"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fileURLToPath(new URL("./publication-process-gh.mjs", import.meta.url)))} ${JSON.stringify(pathToFileURL(config).href)} "$@"\n`,
    { mode: 0o755 },
  );
  return {
    apiBaseUrl: endpoint,
    cert,
    git,
    head,
    get effects() {
      return { physicalCas, reads, requests, objectWrites, pullRequests: pulls.length };
    },
    recover() {
      unavailable = false;
    },
    close: () => closeHttpServer(server),
  };
}
