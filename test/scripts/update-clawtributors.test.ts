import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

const originalCwd = process.cwd();
const contributorsArgs = [
  "api",
  "repos/openclaw/openclaw/contributors?per_page=100&anon=1",
  "--paginate",
];
const mergedAuthorsArgs = [
  "pr",
  "list",
  "-R",
  "openclaw/openclaw",
  "--state",
  "merged",
  "--limit",
  "5000",
  "--json",
  "author",
  "--jq",
  ".[].author.login",
];
const avatar = (alt: string) =>
  `<img src="https://avatars.githubusercontent.com/u/42?v=4&s=48" width="48" height="48" alt="${alt}">`;
const credit = (login: string, alt: string) =>
  `<a href="https://github.com/${login}">${avatar(alt)}</a>`;
const githubUser = (login: string, id: number) => ({
  id,
  login,
  html_url: `https://github.com/${login}`,
  avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock("node:fs");
  vi.doUnmock("node:child_process");
  vi.doUnmock("../../scripts/lib/plain-gh.mjs");
  vi.resetModules();
});

function mockClawtributorsFixture({
  ensureLogins = [],
  seedEntry,
  accountLookup,
  accountLookupError,
}: {
  ensureLogins?: string[];
  seedEntry?: string;
  accountLookup?: ReturnType<typeof githubUser> | null;
  accountLookupError?: Error;
} = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 404 })),
  );
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const markers = "<!-- clawtributors:start -->\n<!-- clawtributors:end -->";
  const readme = `# Fixture\n\nThanks to all clawtributors:\n\n${markers}\n`;
  let writtenReadme = "";
  vi.doMock("node:fs", () => ({
    readFileSync: vi.fn((path: string) => {
      if (path.endsWith("scripts/clawtributors-map.json")) {
        return `${JSON.stringify({ ensureLogins, seedCommit: seedEntry ? "seed-sha" : undefined })}\n`;
      }
      if (path.endsWith("README.md")) {
        return readme;
      }
      throw new Error(`unexpected read: ${path}`);
    }),
    writeFileSync: vi.fn((path: string, data: string) => {
      if (path.endsWith("README.md")) {
        writtenReadme = data;
        return;
      }
      throw new Error(`unexpected write: ${path}`);
    }),
  }));
  const contributor = { ...githubUser("octo", 1), name: "Octo", contributions: 3 };
  const gitOutput: Record<string, string> = {
    "git log --reverse --format=%aN%x1f%aE%x1f%aI --numstat": "",
    "git rev-list --max-parents=0 HEAD": "root-sha\n",
    "git log --format=%aI -1 root-sha": "2024-01-01T00:00:00Z\n",
  };
  const execSync = vi.fn((cmd: string) => {
    if (Object.hasOwn(gitOutput, cmd)) {
      return gitOutput[cmd];
    }
    if (cmd === "git show seed-sha:README.md" && seedEntry) {
      return readme.replace(
        markers,
        `<!-- clawtributors:start -->\n${seedEntry}\n<!-- clawtributors:end -->`,
      );
    }
    throw new Error(`unexpected command: ${cmd}`);
  });
  const execPlainGh = vi.fn((args: readonly string[]) => {
    if (args.join("\0") === contributorsArgs.join("\0")) {
      return `${JSON.stringify([contributor])}\n`;
    }
    if (args.join("\0") === mergedAuthorsArgs.join("\0")) {
      return "";
    }
    if (args[0] === "api" && args[1]?.startsWith("users/")) {
      const login = args[1].slice("users/".length);
      return JSON.stringify(githubUser(login, 2));
    }
    if (args[0] === "api" && args[1]?.startsWith("user/")) {
      if (accountLookupError) {
        throw accountLookupError;
      }
      if (!accountLookup) {
        throw Object.assign(new Error("gh api failed"), {
          stderr: Buffer.from("gh: account missing (HTTP 404)\n"),
        });
      }
      return JSON.stringify(accountLookup);
    }
    throw new Error(`unexpected gh arguments: ${args.join(" ")}`);
  });
  vi.doMock("../../scripts/lib/plain-gh.mjs", () => ({ execPlainGh }));
  vi.doMock("node:child_process", () => ({ execSync }));
  return { execPlainGh, readWrittenReadme: () => writtenReadme };
}

async function importUpdateClawtributors() {
  const scriptUrl = pathToFileURL(resolve(originalCwd, "scripts/update-clawtributors.ts")).href;
  await import(`${scriptUrl}?case=${Date.now()}`);
}

it("bounds every GitHub CLI lookup", async () => {
  const fixture = mockClawtributorsFixture({ ensureLogins: ["extra"] });

  await importUpdateClawtributors();

  const options = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 200,
    timeout: 120_000,
    killSignal: "SIGKILL",
  };
  expect(fixture.execPlainGh).toHaveBeenNthCalledWith(1, contributorsArgs, options);
  expect(fixture.execPlainGh).toHaveBeenNthCalledWith(2, ["api", "users/extra"], options);
  expect(fixture.execPlainGh).toHaveBeenNthCalledWith(3, mergedAuthorsArgs, options);
});

it.each([githubUser("new-handle", 42), null])(
  "preserves seed credit after account lookup: %j",
  async (accountLookup) => {
    const alt = "Original credit";
    const fixture = mockClawtributorsFixture({
      seedEntry: credit("old-handle", alt),
      accountLookup,
    });
    await importUpdateClawtributors();
    expect(fixture.execPlainGh).toHaveBeenCalledWith(
      ["api", "user/42"],
      expect.objectContaining({ timeout: 120_000, killSignal: "SIGKILL" }),
    );
    expect(fixture.readWrittenReadme()).toContain(
      accountLookup ? credit(accountLookup.login, alt) : avatar(alt),
    );
    expect(fixture.readWrittenReadme()).not.toContain('href="https://github.com/old-handle"');
  },
);

it("aborts instead of unlinking credit on transient account lookup failures", async () => {
  const fixture = mockClawtributorsFixture({
    seedEntry: credit("current-handle", "Current contributor"),
    accountLookupError: new Error("GitHub API unavailable"),
  });

  await expect(importUpdateClawtributors()).rejects.toThrow("GitHub API unavailable");

  expect(fixture.readWrittenReadme()).toBe("");
});

it.each([
  { size: 40, visible: true },
  { size: 420, visible: false },
])("renders avatar size $size with visibility $visible", async ({ size, visible }) => {
  const fixture = mockClawtributorsFixture();
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(size, 16);
  png.writeUInt32BE(size, 20);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(png)),
  );

  await importUpdateClawtributors();

  expect(fixture.readWrittenReadme().includes('href="https://github.com/octo"')).toBe(visible);
});

it("cancels stalled avatar probe body reads at the probe timeout", async () => {
  const fixture = mockClawtributorsFixture();
  let signal: AbortSignal | undefined;
  let canceled = false;
  let markFetchStarted!: () => void;
  const fetchStarted = new Promise<void>((resolveStarted) => {
    markFetchStarted = resolveStarted;
  });
  vi.stubGlobal("fetch", ((_url, init) => {
    signal = init?.signal ?? undefined;
    markFetchStarted();
    return Promise.resolve(
      new Response(
        new ReadableStream({
          pull() {
            return new Promise(() => {});
          },
          cancel() {
            canceled = true;
          },
        }),
      ),
    );
  }) as typeof fetch);

  vi.useFakeTimers();
  const imported = importUpdateClawtributors();

  await fetchStarted;
  await vi.advanceTimersByTimeAsync(8000);
  await imported;
  await Promise.resolve();

  expect(signal?.aborted).toBe(true);
  expect(canceled).toBe(true);
  expect(fixture.readWrittenReadme()).toContain("https://github.com/octo");
});
