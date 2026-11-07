import { beforeEach, expect, it, vi } from "vitest";
import { sessionsArtifactsCommand } from "./sessions-artifacts.js";

const mocks = vi.hoisted(() => ({ callGateway: vi.fn(), writeFile: vi.fn() }));

vi.mock("../cli/gateway-rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/gateway-rpc.js")>()),
  callGatewayFromCliWithTransport: mocks.callGateway,
}));

vi.mock("node:fs/promises", () => ({ writeFile: mocks.writeFile }));

function runtime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn(), writeStdout: vi.fn(), writeJson: vi.fn() };
}

function printed(out: ReturnType<typeof runtime>): string {
  return out.log.mock.calls.map(([line]) => String(line)).join("\n");
}

const listResult = () => ({
  artifacts: [
    {
      id: "art-1",
      type: "image",
      title: "Screenshot",
      mimeType: "image/png",
      sizeBytes: 2048,
      runId: "run-1",
      download: { mode: "bytes" },
    },
  ],
});

beforeEach(() => vi.clearAllMocks());

it("lists artifacts with sizes and runs", async () => {
  mocks.callGateway.mockResolvedValue(listResult());
  const out = runtime();

  await sessionsArtifactsCommand({ sessionKey: "agent:main:main" }, out);

  expect(mocks.callGateway).toHaveBeenCalledWith(
    "artifacts.list",
    expect.objectContaining({ json: undefined }),
    { sessionKey: "agent:main:main" },
    expect.objectContaining({ defaultTimeoutMs: 30_000 }),
  );
  const text = printed(out);
  expect(text).toContain("art-1");
  expect(text).toContain("2.0KB");
  expect(out.exit).not.toHaveBeenCalled();
});

it("forwards run and agent scope selectors", async () => {
  mocks.callGateway.mockResolvedValue(listResult());
  const out = runtime();

  await sessionsArtifactsCommand(
    { sessionKey: "agent:main:main", run: "run-1", agent: "main" },
    out,
  );

  expect(mocks.callGateway).toHaveBeenCalledWith(
    "artifacts.list",
    expect.anything(),
    { sessionKey: "agent:main:main", runId: "run-1", agentId: "main" },
    expect.anything(),
  );
});

it("fetches one artifact's bytes to --output", async () => {
  mocks.callGateway.mockResolvedValue({
    artifact: { ...listResult().artifacts[0], download: { mode: "bytes" } },
    encoding: "base64",
    data: Buffer.from("png-bytes").toString("base64"),
  });
  const out = runtime();

  await sessionsArtifactsCommand(
    { sessionKey: "agent:main:main", artifactId: "art-1", output: "art-1.png" },
    out,
  );

  expect(mocks.callGateway).toHaveBeenCalledWith(
    "artifacts.download",
    expect.anything(),
    { sessionKey: "agent:main:main", artifactId: "art-1" },
    expect.anything(),
  );
  expect(mocks.writeFile).toHaveBeenCalledWith("art-1.png", Buffer.from("png-bytes"));
  expect(printed(out)).toContain("Wrote art-1.png (9 bytes).");
});

it("prints the signed url for url-mode artifacts", async () => {
  mocks.callGateway.mockResolvedValue({
    artifact: { ...listResult().artifacts[0], download: { mode: "url" } },
    url: "https://example.test/art-1",
  });
  const out = runtime();

  await sessionsArtifactsCommand({ sessionKey: "agent:main:main", artifactId: "art-1" }, out);

  expect(printed(out)).toContain("https://example.test/art-1");
});

it("exits nonzero for unsupported download modes", async () => {
  mocks.callGateway.mockResolvedValue({
    artifact: { ...listResult().artifacts[0], download: { mode: "unsupported" } },
  });
  const out = runtime();

  await sessionsArtifactsCommand({ sessionKey: "agent:main:main", artifactId: "art-1" }, out);

  expect(out.error).toHaveBeenCalledWith("Artifact art-1 cannot be downloaded inline.");
  expect(out.exit).toHaveBeenCalledWith(1);
});

it("rejects blank selectors before dispatch", async () => {
  await expect(sessionsArtifactsCommand({ sessionKey: "   " }, runtime())).rejects.toThrow(
    "Session key must not be blank.",
  );
  await expect(
    sessionsArtifactsCommand({ sessionKey: "agent:main:main", artifactId: "  " }, runtime()),
  ).rejects.toThrow("Artifact id must not be blank.");
  await expect(
    sessionsArtifactsCommand({ sessionKey: "agent:main:main", run: "  " }, runtime()),
  ).rejects.toThrow("--run must not be blank.");
  await expect(
    sessionsArtifactsCommand({ sessionKey: "agent:main:main", agent: "  " }, runtime()),
  ).rejects.toThrow("--agent must not be blank");
  expect(mocks.callGateway).not.toHaveBeenCalled();
});

it("emits the raw response as JSON", async () => {
  mocks.callGateway.mockResolvedValue(listResult());
  const out = runtime();

  await sessionsArtifactsCommand({ sessionKey: "agent:main:main", json: true }, out);

  expect(out.writeJson).toHaveBeenCalledWith(listResult(), 2);
  expect(out.log).not.toHaveBeenCalled();
});
