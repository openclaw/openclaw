// Tests for system-commands handler
// Phase 5.4: Handler test skeleton

const assert = require("assert");
const handler = require("../handlers/system-commands.cjs");

// Mock dependencies
const mockDeps = {
  detectExecAction: (text) => {
    if (text.includes("docker ps")) {
      return { action: "docker_ps", args: [] };
    }
    if (text.includes("重啟")) {
      return { action: "restart-service", args: ["test"] };
    }
    return null;
  },
  localExec: async (action, args) => {
    if (action === "docker_ps") {
      return "CONTAINER ID  IMAGE  STATUS\nabc123  nginx  Up 2 hours";
    }
    throw new Error("unknown action");
  },
  detectSystemIntent: (text) => {
    if (text.includes("系統狀態")) {
      return { type: "health" };
    }
    if (text.includes("/status")) {
      return { type: "status" };
    }
    return null;
  },
  handleSystemCommand: async (type) => {
    return `System ${type}: OK`;
  },
};

handler.init(mockDeps);

async function testExecMatch() {
  const ctx = { userText: "docker ps" };
  const result = handler.match(ctx);
  assert.ok(result, "should match docker ps");
  assert.equal(result.type, "exec");
  assert.equal(result.execAction.action, "docker_ps");
}

async function testSystemMatch() {
  const ctx = { userText: "系統狀態" };
  const result = handler.match(ctx);
  assert.ok(result, "should match system status");
  assert.equal(result.type, "system");
}

async function testNoMatch() {
  const ctx = { userText: "你好" };
  const result = handler.match(ctx);
  assert.ok(!result, "should not match greeting");
}

async function testExecSuccess() {
  const ctx = {
    userText: "docker ps",
    type: "exec",
    execAction: { action: "docker_ps", args: [] },
  };
  const result = await handler.execute(ctx);
  assert.equal(result.status, "handled");
  assert.ok(result.body.includes("nginx"));
  assert.equal(result.executor, "local");
  assert.equal(result.tracePatch.route_path, "exec_direct");
}

async function testSystemSuccess() {
  const ctx = { userText: "系統狀態", type: "system", sysIntent: { type: "health" } };
  const result = await handler.execute(ctx);
  assert.equal(result.status, "handled");
  assert.ok(result.body.includes("OK"));
  assert.equal(result.executor, "local");
}

// Run tests
void (async () => {
  const tests = [testExecMatch, testSystemMatch, testNoMatch, testExecSuccess, testSystemSuccess];
  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test();
      passed++;
      console.log(`  ✓ ${test.name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${test.name}: ${e.message}`);
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
