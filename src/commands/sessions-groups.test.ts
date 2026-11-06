import { beforeEach, expect, it, vi } from "vitest";
import { sessionsGroupsCommand } from "./sessions-groups.js";

const mocks = vi.hoisted(() => ({ callGateway: vi.fn() }));

vi.mock("../cli/gateway-rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/gateway-rpc.js")>()),
  callGatewayFromCliWithTransport: mocks.callGateway,
}));

function runtime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn(), writeStdout: vi.fn(), writeJson: vi.fn() };
}

function printed(out: ReturnType<typeof runtime>): string {
  return out.log.mock.calls.map(([line]) => String(line)).join("\n");
}

const result = () => ({
  groups: [
    { name: "Work", position: 0 },
    { name: "Personal", position: 1 },
  ],
  sectionOrder: ["groups"],
});

beforeEach(() => vi.clearAllMocks());

it("lists the ordered group catalog", async () => {
  mocks.callGateway.mockResolvedValue(result());
  const out = runtime();

  await sessionsGroupsCommand({}, out);

  expect(mocks.callGateway).toHaveBeenCalledWith(
    "sessions.groups.list",
    expect.objectContaining({ json: undefined }),
    {},
    expect.objectContaining({ defaultTimeoutMs: 30_000 }),
  );
  const text = printed(out);
  expect(text).toContain("Work");
  expect(text).toContain("Personal");
  expect(text).toContain("groups");
  expect(out.exit).not.toHaveBeenCalled();
});

it("exits nonzero when the gateway call fails", async () => {
  mocks.callGateway.mockRejectedValue(new Error("gateway unavailable"));
  const out = runtime();

  await sessionsGroupsCommand({}, out);

  expect(out.error).toHaveBeenCalledWith("Session groups read failed: gateway unavailable");
  expect(out.exit).toHaveBeenCalledWith(1);
});

it("emits the raw response as JSON", async () => {
  mocks.callGateway.mockResolvedValue(result());
  const out = runtime();

  await sessionsGroupsCommand({ json: true }, out);

  expect(out.writeJson).toHaveBeenCalledWith(result(), 2);
  expect(out.log).not.toHaveBeenCalled();
});
