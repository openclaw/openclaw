import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  expandHomePrefix,
  resolveEffectiveHomeDir,
  resolveHomeRelativePath,
  resolveOsHomeDir,
  resolveOsHomeRelativePath,
  resolveRequiredHomeDir,
} from "./home-dir.js";

describe("resolveEffectiveHomeDir", () => {
  it.each([
    {
      name: "prefers OPENCLAW_HOME over HOME and USERPROFILE",
      env: {
        OPENCLAW_HOME: " /srv/openclaw-home ",
        HOME: "/home/other",
        USERPROFILE: "C:/Users/other",
      } as NodeJS.ProcessEnv,
      homedir: () => "/fallback",
      expected: "/srv/openclaw-home",
    },
    {
      name: "falls back to HOME",
      env: { HOME: " /home/alice " } as NodeJS.ProcessEnv,
      expected: "/home/alice",
    },
    {
      name: "falls back to USERPROFILE when HOME is blank",
      env: {
        HOME: "   ",
        USERPROFILE: " C:/Users/alice ",
      } as NodeJS.ProcessEnv,
      expected: "C:/Users/alice",
    },
    {
      name: "falls back to homedir when env values are blank",
      env: {
        OPENCLAW_HOME: " ",
        HOME: " ",
        USERPROFILE: "\t",
      } as NodeJS.ProcessEnv,
      homedir: () => " /fallback ",
      expected: "/fallback",
    },
    {
      name: "treats literal undefined env values as unset",
      env: {
        OPENCLAW_HOME: "undefined",
        HOME: "undefined",
        USERPROFILE: "null",
      } as NodeJS.ProcessEnv,
      homedir: () => " /fallback ",
      expected: "/fallback",
    },
  ])("$name", ({ env, homedir, expected }) => {
    expect(resolveEffectiveHomeDir(env, homedir)).toBe(path.resolve(expected));
  });

  it.each([
    {
      name: "expands ~/ using HOME",
      env: {
        OPENCLAW_HOME: "~/svc",
        HOME: "/home/alice",
      } as NodeJS.ProcessEnv,
      expected: "/home/alice/svc",
    },
    {
      name: "expands ~\\\\ using USERPROFILE",
      env: {
        OPENCLAW_HOME: "~\\svc",
        HOME: " ",
        USERPROFILE: "C:/Users/alice",
      } as NodeJS.ProcessEnv,
      expected: "C:/Users/alice\\svc",
    },
  ])("$name", ({ env, expected }) => {
    expect(resolveEffectiveHomeDir(env)).toBe(path.resolve(expected));
  });
});

describe("resolveRequiredHomeDir", () => {
  it("returns cwd when no home source is available", () => {
    expect(
      resolveRequiredHomeDir({} as NodeJS.ProcessEnv, () => {
        throw new Error("no home");
      }),
    ).toBe(process.cwd());
  });

  it("returns a fully resolved path for OPENCLAW_HOME", () => {
    const result = resolveRequiredHomeDir(
      { OPENCLAW_HOME: "/custom/home" } as NodeJS.ProcessEnv,
      () => "/fallback",
    );
    expect(result).toBe(path.resolve("/custom/home"));
  });

  it("returns cwd when OPENCLAW_HOME is tilde-only and no fallback home exists", () => {
    expect(
      resolveRequiredHomeDir({ OPENCLAW_HOME: "~" } as NodeJS.ProcessEnv, () => {
        throw new Error("no home");
      }),
    ).toBe(process.cwd());
  });
});

describe("resolveOsHomeDir", () => {
  it("ignores OPENCLAW_HOME and uses HOME", () => {
    expect(
      resolveOsHomeDir(
        {
          OPENCLAW_HOME: "/srv/openclaw-home",
          HOME: "/home/alice",
          USERPROFILE: "C:/Users/alice",
        } as NodeJS.ProcessEnv,
        () => "/fallback",
      ),
    ).toBe(path.resolve("/home/alice"));
  });
});

describe("expandHomePrefix", () => {
  it.each([
    {
      name: "expands ~/ using effective home",
      input: "~/x",
      opts: {
        env: { OPENCLAW_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv,
      },
      expected: `${path.resolve("/srv/openclaw-home")}/x`,
    },
    {
      name: "expands exact ~ using explicit home",
      input: "~",
      opts: { home: " /srv/openclaw-home " },
      expected: "/srv/openclaw-home",
    },
    {
      name: "expands ~\\\\ using resolved env home",
      input: "~\\x",
      opts: {
        env: { HOME: "/home/alice" } as NodeJS.ProcessEnv,
      },
      expected: `${path.resolve("/home/alice")}\\x`,
    },
    {
      name: "keeps non-tilde values unchanged",
      input: "/tmp/x",
      expected: "/tmp/x",
    },
  ])("$name", ({ input, opts, expected }) => {
    expect(expandHomePrefix(input, opts)).toBe(expected);
  });
});

describe("resolveHomeRelativePath", () => {
  it("returns blank input unchanged", () => {
    expect(resolveHomeRelativePath("   ")).toBe("");
  });

  it("resolves trimmed relative and absolute paths", () => {
    expect(resolveHomeRelativePath(" ./tmp/file.txt ")).toBe(path.resolve("./tmp/file.txt"));
    expect(resolveHomeRelativePath(" /tmp/file.txt ")).toBe(path.resolve("/tmp/file.txt"));
  });

  it("expands tilde paths using the resolved home directory", () => {
    expect(
      resolveHomeRelativePath("~/docs", {
        env: { OPENCLAW_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv,
      }),
    ).toBe(path.resolve("/srv/openclaw-home/docs"));
  });

  it("expands braced environment placeholders", () => {
    expect(
      resolveHomeRelativePath("${XDG_CONFIG_HOME}/workspace/skills", {
        env: { XDG_CONFIG_HOME: "/home/node/.openclaw" } as NodeJS.ProcessEnv,
      }),
    ).toBe(path.resolve("/home/node/.openclaw/workspace/skills"));
  });

  it("expands bare environment placeholders", () => {
    expect(
      resolveHomeRelativePath("$XDG_CONFIG_HOME/workspace/skills", {
        env: { XDG_CONFIG_HOME: "/home/node/.openclaw" } as NodeJS.ProcessEnv,
      }),
    ).toBe(path.resolve("/home/node/.openclaw/workspace/skills"));
  });

  it("keeps unknown placeholders unchanged", () => {
    expect(resolveHomeRelativePath("${MISSING_ENV}/workspace")).toBe(
      path.resolve("${MISSING_ENV}/workspace"),
    );
  });

  it("keeps inherited placeholder names unchanged", () => {
    expect(resolveHomeRelativePath("$toString/workspace", { env: {} as NodeJS.ProcessEnv })).toBe(
      path.resolve("$toString/workspace"),
    );
  });

  it("expands env placeholders with tilde values without duplicating home", () => {
    expect(
      resolveHomeRelativePath("${OPENCLAW_HOME}/plugins", {
        env: {
          OPENCLAW_HOME: "~/.openclaw",
          HOME: "/home/alice",
        } as NodeJS.ProcessEnv,
      }),
    ).toBe(path.resolve("/home/alice/.openclaw/plugins"));
  });

  it("falls back to cwd when tilde paths have no home source", () => {
    expect(
      resolveHomeRelativePath("~", {
        env: {} as NodeJS.ProcessEnv,
        homedir: () => {
          throw new Error("no home");
        },
      }),
    ).toBe(path.resolve(process.cwd()));
  });
});

describe("resolveOsHomeRelativePath", () => {
  it("expands tilde paths using the OS home instead of OPENCLAW_HOME", () => {
    expect(
      resolveOsHomeRelativePath("~/docs", {
        env: {
          OPENCLAW_HOME: "/srv/openclaw-home",
          HOME: "/home/alice",
        } as NodeJS.ProcessEnv,
      }),
    ).toBe(path.resolve("/home/alice/docs"));
  });

  it("expands braced environment placeholders", () => {
    expect(
      resolveOsHomeRelativePath("${XDG_CONFIG_HOME}/workspace/skills", {
        env: { XDG_CONFIG_HOME: "/home/node/.openclaw" } as NodeJS.ProcessEnv,
      }),
    ).toBe(path.resolve("/home/node/.openclaw/workspace/skills"));
  });

  it("keeps empty-string environment placeholders unchanged", () => {
    expect(
      resolveOsHomeRelativePath("${XDG_CONFIG_HOME}/workspace", {
        env: { XDG_CONFIG_HOME: "   " } as NodeJS.ProcessEnv,
      }),
    ).toBe(path.resolve("${XDG_CONFIG_HOME}/workspace"));
  });

  it("keeps inherited placeholder names unchanged", () => {
    expect(resolveOsHomeRelativePath("$toString/workspace", { env: {} as NodeJS.ProcessEnv })).toBe(
      path.resolve("$toString/workspace"),
    );
  });

  it("expands env placeholders with tilde values using OS home", () => {
    expect(
      resolveOsHomeRelativePath("${XDG_CONFIG_HOME}/workspace", {
        env: {
          XDG_CONFIG_HOME: "~/.openclaw",
          HOME: "/home/bob",
        } as NodeJS.ProcessEnv,
      }),
    ).toBe(path.resolve("/home/bob/.openclaw/workspace"));
  });
});
