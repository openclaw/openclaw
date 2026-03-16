import { describe, expect, it } from "vitest";
import {
	addAllowlistEntry,
	type ExecApprovalsFile,
	normalizeExecApprovals,
	recordAllowlistUse,
	resolveAllowlistForHost,
	resolveExecApprovalsFromFile,
} from "./exec-approvals.js";

const BASE_FILE: ExecApprovalsFile = {
	version: 1,
	socket: { path: "/tmp/test.sock", token: "test-token" },
	defaults: {},
	agents: {},
};

describe("per-host allowlists (exec-approvals)", () => {
	describe("resolveAllowlistForHost", () => {
		it("returns flat allowlist when no allowlistByHost", () => {
			const file: ExecApprovalsFile = {
				...BASE_FILE,
				agents: {
					"main-agent": {
						allowlist: [{ id: "a", pattern: "/usr/bin/curl" }],
					},
				},
			};
			const resolved = resolveExecApprovalsFromFile({
				file,
				agentId: "main-agent",
				path: "/tmp/test.json",
				socketPath: "/tmp/test.sock",
				token: "test-token",
			});
			expect(resolved.allowlistByHost).toBeNull();
			const list = resolveAllowlistForHost(resolved, "gateway");
			expect(list).toHaveLength(1);
			expect(list[0].pattern).toBe("/usr/bin/curl");
		});

		it("returns host-specific entries when map format is used", () => {
			const file: ExecApprovalsFile = {
				...BASE_FILE,
				agents: {
					"main-agent": {
						allowlist: {
							gateway: [{ id: "g1", pattern: "/usr/bin/gh" }],
							sandbox: [{ id: "s1", pattern: "python3" }],
						},
					},
				},
			};
			const resolved = resolveExecApprovalsFromFile({
				file,
				agentId: "main-agent",
				path: "/tmp/test.json",
				socketPath: "/tmp/test.sock",
				token: "test-token",
			});
			expect(resolved.allowlistByHost).not.toBeNull();

			const gatewayList = resolveAllowlistForHost(resolved, "gateway");
			expect(gatewayList).toHaveLength(1);
			expect(gatewayList[0].pattern).toBe("/usr/bin/gh");

			const sandboxList = resolveAllowlistForHost(resolved, "sandbox");
			expect(sandboxList).toHaveLength(1);
			expect(sandboxList[0].pattern).toBe("python3");
		});

		it("falls back to 'default' key when host-specific entry is absent", () => {
			const file: ExecApprovalsFile = {
				...BASE_FILE,
				agents: {
					"main-agent": {
						allowlist: {
							default: [{ id: "d1", pattern: "/usr/bin/curl" }],
							gateway: [{ id: "g1", pattern: "/usr/bin/gh" }],
						},
					},
				},
			};
			const resolved = resolveExecApprovalsFromFile({
				file,
				agentId: "main-agent",
				path: "/tmp/test.json",
				socketPath: "/tmp/test.sock",
				token: "test-token",
			});

			// "node" not present → falls back to "default"
			const nodeList = resolveAllowlistForHost(resolved, "node");
			expect(nodeList).toHaveLength(1);
			expect(nodeList[0].pattern).toBe("/usr/bin/curl");

			// "gateway" has explicit entry
			const gatewayList = resolveAllowlistForHost(resolved, "gateway");
			expect(gatewayList).toHaveLength(1);
			expect(gatewayList[0].pattern).toBe("/usr/bin/gh");
		});

		it("returns empty array when no entries match and no default", () => {
			const file: ExecApprovalsFile = {
				...BASE_FILE,
				agents: {
					"main-agent": {
						allowlist: {
							gateway: [{ id: "g1", pattern: "/usr/bin/gh" }],
						},
					},
				},
			};
			const resolved = resolveExecApprovalsFromFile({
				file,
				agentId: "main-agent",
				path: "/tmp/test.json",
				socketPath: "/tmp/test.sock",
				token: "test-token",
			});

			const sandboxList = resolveAllowlistForHost(resolved, "sandbox");
			expect(sandboxList).toHaveLength(0);
		});
	});

	describe("backward compatibility: legacy array → treated as flat list", () => {
		it("resolves as flat allowlist when value is an array", () => {
			const file: ExecApprovalsFile = {
				...BASE_FILE,
				agents: {
					"main-agent": {
						allowlist: [
							{ id: "a1", pattern: "/usr/bin/curl" },
							{ id: "a2", pattern: "/usr/bin/gh" },
						],
					},
				},
			};
			const resolved = resolveExecApprovalsFromFile({
				file,
				agentId: "main-agent",
				path: "/tmp/test.json",
				socketPath: "/tmp/test.sock",
				token: "test-token",
			});
			expect(resolved.allowlistByHost).toBeNull();
			expect(resolved.allowlist).toHaveLength(2);
			// resolveAllowlistForHost returns flat list for any host
			expect(resolveAllowlistForHost(resolved, "gateway")).toHaveLength(2);
			expect(resolveAllowlistForHost(resolved, "sandbox")).toHaveLength(2);
		});
	});

	describe("empty bucket does not fall back to default", () => {
		it("returns empty array when host bucket is explicitly empty (not null/undefined)", () => {
			const file: ExecApprovalsFile = {
				...BASE_FILE,
				agents: {
					"main-agent": {
						allowlist: {
							gateway: [{ id: "g1", pattern: "/usr/bin/gh" }],
							sandbox: [],
						},
					},
				},
			};
			const resolved = resolveExecApprovalsFromFile({
				file,
				agentId: "main-agent",
				path: "/tmp/test.json",
				socketPath: "/tmp/test.sock",
				token: "test-token",
			});

			// sandbox bucket exists but is empty — should NOT fall back to gateway or default
			const sandboxList = resolveAllowlistForHost(resolved, "sandbox");
			expect(sandboxList).toHaveLength(0);

			// gateway bucket should still work
			const gatewayList = resolveAllowlistForHost(resolved, "gateway");
			expect(gatewayList).toHaveLength(1);
		});
	});

	describe("wildcard agent entries", () => {
		it("merges wildcard flat entries into per-host resolution", () => {
			const file: ExecApprovalsFile = {
				...BASE_FILE,
				agents: {
					"*": {
						allowlist: [{ id: "w1", pattern: "/usr/bin/env" }],
					},
					"main-agent": {
						allowlist: {
							gateway: [{ id: "g1", pattern: "/usr/bin/gh" }],
						},
					},
				},
			};
			const resolved = resolveExecApprovalsFromFile({
				file,
				agentId: "main-agent",
				path: "/tmp/test.json",
				socketPath: "/tmp/test.sock",
				token: "test-token",
			});
			// allowlistByHost is set because agent uses map format
			expect(resolved.allowlistByHost).not.toBeNull();
			// gateway bucket: wildcard flat entries merged in
			const gatewayList = resolveAllowlistForHost(resolved, "gateway");
			expect(gatewayList.map((e) => e.pattern)).toContain("/usr/bin/env");
			expect(gatewayList.map((e) => e.pattern)).toContain("/usr/bin/gh");
		});
	});
});

describe("addAllowlistEntry with per-host map format", () => {
	it("adds entry to the correct host bucket", () => {
		const file: ExecApprovalsFile = {
			...BASE_FILE,
			agents: {
				myagent: {
					allowlist: {
						gateway: [{ id: "g1", pattern: "/usr/bin/gh" }],
						sandbox: [],
					},
				},
			},
		};
		addAllowlistEntry(file, "myagent", "/usr/bin/curl", "gateway");
		const al = file.agents?.myagent?.allowlist as Record<
			string,
			{ pattern: string }[]
		>;
		expect(al.gateway.map((e) => e.pattern)).toContain("/usr/bin/curl");
		expect(al.sandbox).toHaveLength(0);
	});

	it("does not overwrite the per-host map when host is undefined", () => {
		const file: ExecApprovalsFile = {
			...BASE_FILE,
			agents: {
				myagent: {
					allowlist: {
						gateway: [{ id: "g1", pattern: "/usr/bin/gh" }],
					},
				},
			},
		};
		// No host passed — should not corrupt the map
		addAllowlistEntry(file, "myagent", "/usr/bin/curl");
		const al = file.agents?.myagent?.allowlist;
		// Map format should still be intact
		expect(typeof al === "object" && !Array.isArray(al)).toBe(true);
		const map = al as Record<string, { pattern: string }[]>;
		expect(map.gateway.map((e) => e.pattern)).toContain("/usr/bin/gh");
	});
});

describe("recordAllowlistUse with per-host map format", () => {
	it("updates the correct host bucket", () => {
		const file: ExecApprovalsFile = {
			...BASE_FILE,
			agents: {
				myagent: {
					allowlist: {
						gateway: [{ id: "g1", pattern: "/usr/bin/gh", lastUsedAt: 0 }],
						sandbox: [{ id: "s1", pattern: "python3", lastUsedAt: 0 }],
					},
				},
			},
		};
		recordAllowlistUse(
			file,
			"myagent",
			{ id: "g1", pattern: "/usr/bin/gh" },
			"gh auth status",
			"/usr/bin/gh",
			"gateway",
		);
		const map = file.agents?.myagent?.allowlist as Record<
			string,
			{ pattern: string; lastUsedCommand?: string }[]
		>;
		expect(map.gateway[0].lastUsedCommand).toBe("gh auth status");
		// sandbox bucket should be untouched
		expect(map.sandbox[0].lastUsedCommand).toBeUndefined();
	});
});

describe("mergeLegacyAgent preserves map format", () => {
	it("does not drop map data when current uses map format and legacy is array", () => {
		const file: ExecApprovalsFile = {
			...BASE_FILE,
			agents: {
				default: {
					allowlist: [{ id: "legacy1", pattern: "/usr/bin/legacy" }],
				},
				myagent: {
					allowlist: {
						gateway: [{ id: "g1", pattern: "/usr/bin/gh" }],
						sandbox: [{ pattern: "*" }],
					},
				},
			},
		};
		const normalized = normalizeExecApprovals(file);
		const agent = normalized.agents?.myagent;
		const al = agent?.allowlist;
		// Should still be map format
		expect(typeof al === "object" && !Array.isArray(al)).toBe(true);
		const map = al as Record<string, { pattern: string }[]>;
		// gateway bucket preserved
		expect(map.gateway.map((e) => e.pattern)).toContain("/usr/bin/gh");
		// sandbox bucket preserved
		expect(map.sandbox).toBeDefined();
	});
});

describe("addAllowlistEntry safety — no host with map format", () => {
	it("does not corrupt per-host map when host is omitted", () => {
		const file: ExecApprovalsFile = {
			...BASE_FILE,
			agents: {
				myagent: {
					allowlist: {
						gateway: [{ id: "g1", pattern: "/usr/bin/gh" }],
					},
				},
			},
		};
		// No host — should be a no-op, not corrupt the map
		addAllowlistEntry(file, "myagent", "/usr/bin/new-tool");
		const al = file.agents?.myagent?.allowlist;
		expect(typeof al === "object" && !Array.isArray(al)).toBe(true);
		const map = al as Record<string, { pattern: string }[]>;
		expect(map.gateway).toHaveLength(1);
		expect(map.gateway[0].pattern).toBe("/usr/bin/gh");
		// New tool should NOT have been added
		expect(JSON.stringify(map)).not.toContain("new-tool");
	});
});

describe("recordAllowlistUse safety — no host with map format", () => {
	it("does not corrupt per-host map when host is omitted", () => {
		const file: ExecApprovalsFile = {
			...BASE_FILE,
			agents: {
				myagent: {
					allowlist: {
						gateway: [{ id: "g1", pattern: "/usr/bin/gh", lastUsedAt: 0 }],
					},
				},
			},
		};
		// No host — should be a no-op
		recordAllowlistUse(
			file,
			"myagent",
			{ id: "g1", pattern: "/usr/bin/gh" },
			"gh status",
		);
		const al = file.agents?.myagent?.allowlist;
		expect(typeof al === "object" && !Array.isArray(al)).toBe(true);
		const map = al as Record<
			string,
			{ pattern: string; lastUsedCommand?: string }[]
		>;
		// Entry should NOT have been updated (no host = skipped)
		expect(map.gateway[0].lastUsedCommand).toBeUndefined();
	});
});

describe("flat allowlist includes map default bucket for legacy consumers", () => {
	it("resolvedApprovals.allowlist includes 'default' bucket entries when agent uses map format", () => {
		const file: ExecApprovalsFile = {
			...BASE_FILE,
			agents: {
				"node-agent": {
					allowlist: {
						default: [{ id: "d1", pattern: "/usr/bin/curl" }],
						node: [{ id: "n1", pattern: "/usr/bin/special" }],
					},
				},
			},
		};
		const resolved = resolveExecApprovalsFromFile({
			file,
			agentId: "node-agent",
			path: "/tmp/test.json",
			socketPath: "/tmp/test.sock",
			token: "test-token",
		});
		// Flat allowlist should include the "default" bucket for legacy node-host consumers
		expect(resolved.allowlist.map((e) => e.pattern)).toContain("/usr/bin/curl");
	});
});

describe("wildcard map default entries merged into host buckets", () => {
	it("includes wildcard 'default' bucket in host resolution when wildcard uses map format", () => {
		const file: ExecApprovalsFile = {
			...BASE_FILE,
			agents: {
				"*": {
					allowlist: {
						default: [{ id: "wd1", pattern: "/usr/bin/env" }],
						gateway: [{ id: "wg1", pattern: "/usr/bin/curl" }],
					},
				},
				myagent: {
					allowlist: {
						gateway: [{ id: "g1", pattern: "/usr/bin/gh" }],
					},
				},
			},
		};
		const resolved = resolveExecApprovalsFromFile({
			file,
			agentId: "myagent",
			path: "/tmp/test.json",
			socketPath: "/tmp/test.sock",
			token: "test-token",
		});
		const gatewayList = resolveAllowlistForHost(resolved, "gateway");
		// Should include wildcard "default" entries in gateway bucket
		expect(gatewayList.map((e) => e.pattern)).toContain("/usr/bin/env");
		expect(gatewayList.map((e) => e.pattern)).toContain("/usr/bin/gh");
	});
});
