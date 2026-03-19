import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const distRoot = new URL("../dist/", import.meta.url);
const candidate = fs
  .readdirSync(distRoot)
  .find(
    (name) =>
      /^.*\.js$/.test(name) &&
      fs
        .readFileSync(new URL(`../dist/${name}`, import.meta.url), "utf8")
        .includes("async function resolveSubagentCompletionOrigin(params) {"),
  );
assert.ok(candidate, "built dist file containing resolveSubagentCompletionOrigin should exist");

const file = new URL(`../dist/${candidate}`, import.meta.url);
const source = fs.readFileSync(file, "utf8");
const start = source.indexOf("async function resolveSubagentCompletionOrigin(params) {");
const end = source.indexOf("\nasync function sendAnnounce(item) {", start);
assert.ok(start >= 0 && end > start, "resolveSubagentCompletionOrigin should exist");
const fnSource = source.slice(start, end);

function loadResolver(routeResult, hookRunner = null) {
  const sandbox = {
    parseTelegramTopicConversation({ conversationId, parentConversationId }) {
      const direct = /^(-?\d+):topic:(\d+)$/.exec(String(conversationId).trim());
      if (direct) {
        return {
          chatId: direct[1],
          topicId: direct[2],
          canonicalConversationId: `${direct[1]}:topic:${direct[2]}`,
        };
      }
      const child = String(conversationId).trim();
      const parent = parentConversationId == null ? "" : String(parentConversationId).trim();
      if (/^\d+$/.test(child) && /^-?\d+$/.test(parent)) {
        return {
          chatId: parent,
          topicId: child,
          canonicalConversationId: `${parent}:topic:${child}`,
        };
      }
      return null;
    },
    normalizeDeliveryContext(value) {
      return value ? { ...value } : value;
    },
    normalizeAccountId(value) {
      return value == null || value === "" ? "default" : String(value);
    },
    normalizeAccountId$1(value) {
      return value == null || value === "" ? "default" : String(value);
    },
    normalizeAccountId$2(value) {
      return value == null || value === "" ? "default" : String(value);
    },
    normalizeAccountId$3(value) {
      return value == null || value === "" ? "default" : String(value);
    },
    createBoundDeliveryRouter() {
      return {
        resolveDestination(input) {
          sandbox.capturedInput = input;
          return routeResult;
        },
      };
    },
    mergeDeliveryContext(primary, fallback) {
      return { ...fallback, ...primary };
    },
    getGlobalHookRunner() {
      return hookRunner;
    },
    isDeliverableMessageChannel() {
      return true;
    },
    capturedInput: null,
  };
  const script = new vm.Script(
    `${fnSource}; globalThis.resolver = resolveSubagentCompletionOrigin;`,
  );
  vm.createContext(sandbox);
  script.runInContext(sandbox);
  return { resolver: sandbox.resolver, sandbox };
}

{
  const { resolver, sandbox } = loadResolver({
    mode: "bound",
    binding: {
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1003852453363:topic:761",
      },
    },
  });
  const result = await resolver({
    childSessionKey: "agent:coding:subagent:child",
    requesterSessionKey: "agent:main:telegram:group:-1003852453363:topic:761",
    requesterOrigin: {
      channel: "telegram",
      accountId: "default",
      to: "channel:-1003852453363",
      threadId: "761",
    },
    childRunId: "run-1",
    spawnMode: "run",
    expectsCompletionMessage: true,
  });
  assert.equal(sandbox.capturedInput.requester.conversationId, "-1003852453363:topic:761");
  assert.equal(sandbox.capturedInput.requester.parentConversationId, "-1003852453363");
  assert.deepEqual(result, {
    channel: "telegram",
    accountId: "default",
    to: "channel:-1003852453363",
    threadId: "761",
  });
}

{
  const { resolver, sandbox } = loadResolver({
    mode: "bound",
    binding: {
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123456789",
      },
    },
  });
  const result = await resolver({
    childSessionKey: "agent:coding:subagent:child",
    requesterSessionKey: "agent:main:telegram:direct:123456789",
    requesterOrigin: {
      channel: "telegram",
      accountId: "default",
      to: "channel:123456789",
      threadId: "123456789",
    },
    childRunId: "run-dm",
    spawnMode: "run",
    expectsCompletionMessage: true,
  });
  assert.equal(sandbox.capturedInput.requester.conversationId, "123456789");
  assert.equal(sandbox.capturedInput.requester.parentConversationId, "123456789");
  assert.equal(result.channel, "telegram");
  assert.equal(result.accountId, "default");
  assert.equal(result.to, "channel:123456789");
  assert.equal(result.threadId, undefined);
}

{
  const { resolver, sandbox } = loadResolver({
    mode: "bound",
    binding: {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "123-thread",
      },
    },
  });
  const result = await resolver({
    childSessionKey: "agent:coding:subagent:child",
    requesterSessionKey: "agent:main:discord:thread:123-thread",
    requesterOrigin: {
      channel: "discord",
      accountId: "default",
      to: "channel:999-parent",
      threadId: "123-thread",
    },
    childRunId: "run-2",
    spawnMode: "run",
    expectsCompletionMessage: true,
  });
  assert.equal(sandbox.capturedInput.requester.conversationId, "123-thread");
  assert.deepEqual(result, {
    channel: "discord",
    accountId: "default",
    to: "channel:123-thread",
    threadId: "123-thread",
  });
}

console.log("issue-55 completion origin regression checks passed");
