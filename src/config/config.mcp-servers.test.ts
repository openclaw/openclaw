import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("mcp servers config schema", () => {
  it("accepts a valid mcp.servers block", () => {
    const res = OpenClawSchema.safeParse({
      mcp: {
        servers: {
          qmd: {
            command: "/usr/local/bin/qmd",
            args: ["mcp"],
            description: "QMD hybrid search over markdown files",
          },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("accepts a server entry with only command (args and description optional)", () => {
    const res = OpenClawSchema.safeParse({
      mcp: {
        servers: {
          "my-tool": {
            command: "my-mcp-server",
          },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("accepts multiple server entries", () => {
    const res = OpenClawSchema.safeParse({
      mcp: {
        servers: {
          search: { command: "/usr/bin/search-mcp", args: ["--serve"] },
          files: { command: "/usr/bin/files-mcp" },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("accepts mcp with no servers key (fully optional)", () => {
    const res = OpenClawSchema.safeParse({ mcp: {} });
    expect(res.success).toBe(true);
  });

  it("accepts config without mcp key at all", () => {
    const res = OpenClawSchema.safeParse({});
    expect(res.success).toBe(true);
  });

  it("rejects a server name containing a space", () => {
    const res = OpenClawSchema.safeParse({
      mcp: {
        servers: {
          "my server": {
            command: "/usr/bin/thing",
          },
        },
      },
    });

    expect(res.success).toBe(false);
    if (res.success) {
      return;
    }

    const paths = res.error.issues.map((i) => i.path.join("."));
    expect(paths.some((p) => p.includes("my server"))).toBe(true);
  });

  it("rejects a server name containing a special character", () => {
    const res = OpenClawSchema.safeParse({
      mcp: {
        servers: {
          "bad!": {
            command: "/usr/bin/thing",
          },
        },
      },
    });

    expect(res.success).toBe(false);
    if (res.success) {
      return;
    }

    const paths = res.error.issues.map((i) => i.path.join("."));
    expect(paths.some((p) => p.includes("bad!"))).toBe(true);
  });

  it("rejects a server entry missing command", () => {
    const res = OpenClawSchema.safeParse({
      mcp: {
        servers: {
          broken: {
            args: ["mcp"],
          },
        },
      },
    });

    expect(res.success).toBe(false);
    if (res.success) {
      return;
    }

    const paths = res.error.issues.map((i) => i.path.join("."));
    expect(paths.some((p) => p.endsWith("command"))).toBe(true);
  });

  it("rejects an empty string command", () => {
    const res = OpenClawSchema.safeParse({
      mcp: {
        servers: {
          bad: { command: "" },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("rejects unrecognized fields under a server entry (strict schema)", () => {
    const res = OpenClawSchema.safeParse({
      mcp: {
        servers: {
          rogue: {
            command: "/bin/thing",
            unknownField: true,
          },
        },
      },
    });

    expect(res.success).toBe(false);
    if (res.success) {
      return;
    }

    expect(
      res.error.issues.some((issue) => issue.message.toLowerCase().includes("unrecognized")),
    ).toBe(true);
  });

  it("rejects unrecognized fields on the mcp object itself", () => {
    const res = OpenClawSchema.safeParse({
      mcp: {
        servers: {},
        bogus: true,
      },
    });

    expect(res.success).toBe(false);
    if (res.success) {
      return;
    }

    expect(
      res.error.issues.some((issue) => issue.message.toLowerCase().includes("unrecognized")),
    ).toBe(true);
  });

  it("rejects an empty string description", () => {
    const res = OpenClawSchema.safeParse({
      mcp: {
        servers: {
          bad_desc: {
            command: "/usr/bin/thing",
            description: "",
          },
        },
      },
    });

    expect(res.success).toBe(false);
    if (res.success) {
      return;
    }

    const paths = res.error.issues.map((i) => i.path.join("."));
    expect(paths.some((p) => p.includes("description"))).toBe(true);
  });

  it("rejects empty strings in the args array", () => {
    const res = OpenClawSchema.safeParse({
      mcp: {
        servers: {
          bad_args: {
            command: "/usr/bin/thing",
            args: ["--flag", ""],
          },
        },
      },
    });

    expect(res.success).toBe(false);
    if (res.success) {
      return;
    }

    const paths = res.error.issues.map((i) => i.path.join("."));
    expect(paths.some((p) => p.includes("args"))).toBe(true);
  });
});
