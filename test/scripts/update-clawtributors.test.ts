// Update Clawtributors tests cover update clawtributors script behavior.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalCwd = process.cwd();

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock("node:fs");
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

function mockClawtributorsFixture() {
  const readme = [
    "# Fixture",
    "",
    "Thanks to all clawtributors:",
    "",
    "<!-- clawtributors:start -->",
    "<!-- clawtributors:end -->",
    "",
  ].join("\n");
  let writtenReadme = "";
  vi.doMock("node:fs", () => ({
    readFileSync: vi.fn((path: string) => {
      if (path.endsWith("scripts/clawtributors-map.json")) {
        return "{}\n";
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
  const contributor = {
    login: "octo",
    name: "Octo",
    html_url: "https://github.com/octo",
    avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
    contributions: 3,
  };
  const execSync = vi.fn((cmd: string) => {
    if (cmd === 'gh api "repos/openclaw/openclaw/contributors?per_page=100&anon=1" --paginate') {
      return `${JSON.stringify([contributor])}\n`;
    }
    if (cmd === "git log --reverse --format=%aN%x1f%aE%x1f%aI --numstat") {
      return "";
    }
    if (
      cmd ===
      "gh pr list -R openclaw/openclaw --state merged --limit 5000 --json author --jq '.[].author.login'"
    ) {
      return "";
    }
    if (cmd === "git rev-list --max-parents=0 HEAD") {
      return "root-sha\n";
    }
    if (cmd === "git log --format=%aI -1 root-sha") {
      return "2024-01-01T00:00:00Z\n";
    }
    throw new Error(`unexpected command: ${cmd}`);
  });
  vi.doMock("node:child_process", () => ({
    execFileSync: vi.fn(() => {
      throw new Error("unexpected execFileSync");
    }),
    execSync,
  }));
  return {
    readWrittenReadme: () => writtenReadme,
  };
}

async function importUpdateClawtributors() {
  const scriptUrl = pathToFileURL(resolve(originalCwd, "scripts/update-clawtributors.ts")).href;
  await import(`${scriptUrl}?case=${Date.now()}`);
}

describe("update-clawtributors", () => {
  it("rejects unsafe avatar probe content lengths before reading the body", async () => {
    const fixture = mockClawtributorsFixture();
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    vi.stubGlobal("fetch", (() =>
      Promise.resolve({
        ok: true,
        headers: new Headers({ "content-length": "9007199254740992" }),
        arrayBuffer,
      } as unknown as Response)) as typeof fetch);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await importUpdateClawtributors();

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(fixture.readWrittenReadme()).toContain("https://github.com/octo");
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
          { status: 200 },
        ),
      );
    }) as typeof fetch);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

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
});
