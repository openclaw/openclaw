import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW_PATH = ".github/workflows/ios-periphery-comment.yml";

type WorkflowStep = {
  name?: string;
  with?: {
    script?: string;
  };
};

type Workflow = {
  jobs?: {
    comment?: {
      steps?: WorkflowStep[];
    };
  };
};

type Artifact = {
  expired: boolean;
  id: number;
  name: string;
  size_in_bytes?: number;
};

function commenterScript(): string {
  const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;
  const step = workflow.jobs?.comment?.steps?.find(
    (candidate) => candidate.name === "Upsert Periphery PR comment",
  );
  const script = step?.with?.script;
  if (!script) {
    throw new Error("missing iOS Periphery commenter script");
  }
  return script;
}

async function runCommenter(artifact: Artifact, archiveData: Buffer) {
  const script = commenterScript();
  const artifactName = "ios-periphery-dead-code-12345";
  const core = {
    infos: [] as string[],
    warnings: [] as string[],
    info(message: string) {
      this.infos.push(message);
    },
    warning(message: string) {
      this.warnings.push(message);
    },
  };
  let downloadCount = 0;
  const github = {
    rest: {
      actions: {
        listWorkflowRunArtifacts() {},
        async downloadArtifact() {
          downloadCount += 1;
          return { data: archiveData };
        },
      },
      issues: {
        listComments() {},
        async createComment() {},
        async updateComment() {},
      },
      pulls: {
        async get() {
          return {
            data: {
              base: { repo: { full_name: "openclaw/openclaw" } },
              head: { sha: "head-sha" },
              number: 123,
              state: "open",
            },
          };
        },
      },
    },
    async paginate(_request: unknown, params: Record<string, unknown>) {
      if (params.run_id === 12345) {
        return [{ ...artifact, name: artifact.name || artifactName }];
      }
      if (params.issue_number === 123) {
        return [];
      }
      throw new Error(`unexpected paginate call: ${JSON.stringify(params)}`);
    },
  };
  const context = {
    payload: {
      workflow_run: {
        event: "pull_request",
        head_sha: "head-sha",
        id: 12345,
        name: "iOS Periphery Dead Code",
        pull_requests: [{ number: 123 }],
        repository: { full_name: "openclaw/openclaw" },
      },
    },
    repo: {
      owner: "openclaw",
      repo: "openclaw",
    },
  };
  const execute = new Function(
    "require",
    "context",
    "core",
    "github",
    `return (async () => {\n${script}\n})();`,
  ) as (
    require: NodeJS.Require,
    context: typeof context,
    core: typeof core,
    github: typeof github,
  ) => Promise<void>;

  await execute(createRequire(import.meta.url), context, core, github);

  return { core, downloadCount };
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function makeZip(files: Record<string, string>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [name, contents] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name, "utf8");
    const contentsBuffer = Buffer.from(contents, "utf8");
    const checksum = crc32(contentsBuffer);
    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(checksum),
      u32(contentsBuffer.length),
      u32(contentsBuffer.length),
      u16(nameBuffer.length),
      u16(0),
      nameBuffer,
    ]);
    localParts.push(localHeader, contentsBuffer);
    centralParts.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(checksum),
        u32(contentsBuffer.length),
        u32(contentsBuffer.length),
        u16(nameBuffer.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32((0o100644 << 16) >>> 0),
        u32(offset),
        nameBuffer,
      ]),
    );
    offset += localHeader.length + contentsBuffer.length;
  }

  const localData = Buffer.concat(localParts);
  const centralDirectory = Buffer.concat(centralParts);
  const endOfCentralDirectory = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(Object.keys(files).length),
    u16(Object.keys(files).length),
    u32(centralDirectory.length),
    u32(localData.length),
    u16(0),
  ]);

  return Buffer.concat([localData, centralDirectory, endOfCentralDirectory]);
}

describe("iOS Periphery comment workflow", () => {
  it("parses the workflow YAML and embedded github-script JavaScript", () => {
    expect(() => commenterScript()).not.toThrow();
    expect(
      () =>
        new Function(
          "require",
          "context",
          "core",
          "github",
          `return (async () => {\n${commenterScript()}\n})();`,
        ),
    ).not.toThrow();
  });

  it("accepts a valid small Periphery artifact", async () => {
    const archive = makeZip({
      "periphery.json": "[]\n",
      "periphery.status": "0\n",
    });
    const result = await runCommenter(
      {
        expired: false,
        id: 77,
        name: "ios-periphery-dead-code-12345",
        size_in_bytes: archive.length,
      },
      archive,
    );

    expect(result.downloadCount).toBe(1);
    expect(result.core.warnings).toEqual([]);
  });

  it("rejects oversized artifact metadata before download", async () => {
    const result = await runCommenter(
      {
        expired: false,
        id: 77,
        name: "ios-periphery-dead-code-12345",
        size_in_bytes: 1024 * 1024 + 1,
      },
      Buffer.alloc(0),
    );

    expect(result.downloadCount).toBe(0);
    expect(result.core.warnings).toEqual([
      "Skipping ios-periphery-dead-code-12345; compressed artifact size 1048577 exceeds the 1048576 byte limit.",
    ]);
  });
});
