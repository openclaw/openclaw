/** Tests parsing of inline reply directives and command tags. */
import { describe, expect, it } from "vitest";
import { parseInlineSessionDirectives } from "./reply/directive-handling.parse.js";
import { extractThinkDirective } from "./reply/directives.js";
import { extractExecDirective } from "./reply/exec/directive.js";
import { extractQueueDirective } from "./reply/queue/directive.js";

describe("directive parsing", () => {
  it.each(["  ordinary\t text\r\n    if ready:\r\n        run('a  b')  \r\n"])(
    "preserves all bytes when no directive is recognized: %j",
    (body) => {
      expect(parseInlineSessionDirectives(body).cleaned).toBe(body);
    },
  );

  it.each(["/think high", "/status:"])(
    "preserves code and significant spacing around %s",
    (directive) => {
      const code =
        "\r\n```python\r\n    if ready:\r\n        run('a  b')\r\n\t\tfinish()  \r\n```\r\n";
      const parsed = parseInlineSessionDirectives(
        `  Keep\t spacing ${directive} here  too${code}`,
        {
          modelAliases: ["sample"],
        },
      );
      expect(parsed.cleaned).toBe(`  Keep\t spacing here  too${code}`);
    },
  );

  it.each(["/sample"])(
    "does not consume indentation after the last argument of %s",
    (directive) => {
      const code = "    if ready:\r\n        run()  \r\n";
      expect(
        parseInlineSessionDirectives(`${directive}\r\n${code}`, {
          modelAliases: ["sample"],
        }).cleaned,
      ).toBe(code);
    },
  );

  it.each([
    ["/exec\n host=auto\n security=deny\r\n", { execHost: "auto", execSecurity: "deny" }],
    ["/queue\n collect\n cap:5\r\n", { queueMode: "collect", cap: 5 }],
    ["/think\n high\r\n", { thinkLevel: "high" }],
    [
      "/model\n example/model\n -s\r\n",
      { rawModelDirective: "example/model", modelScope: "session" },
    ],
  ])(
    "keeps cross-line argument grammar without consuming the following code: %j",
    (directive, fields) => {
      const code = "    print('a  b')\r\n";
      const parsed = parseInlineSessionDirectives(`${directive}${code}`);
      expect(parsed).toMatchObject(fields);
      expect(parsed.cleaned).toBe(code);
    },
  );

  it("keeps first-match precedence while removing different directive kinds", () => {
    const parsed = parseInlineSessionDirectives(
      "/think high /think low /verbose on\r\n    code  here",
    );
    expect(parsed.thinkLevel).toBe("high");
    expect(parsed.verboseLevel).toBe("on");
    expect(parsed.cleaned).toBe("/think low\r\n    code  here");
  });

  it("parses default thinking and fast directives as override clears", () => {
    const think = parseInlineSessionDirectives("/think default");
    expect(think.hasThinkDirective).toBe(true);
    expect(think.thinkLevel).toBeUndefined();
    expect(think.rawThinkLevel).toBe("default");
    expect(think.clearThinkLevel).toBe(true);

    const fast = parseInlineSessionDirectives("/fast inherit");
    expect(fast.hasFastDirective).toBe(true);
    expect(fast.fastMode).toBeUndefined();
    expect(fast.rawFastMode).toBe("inherit");
    expect(fast.clearFastMode).toBe(true);
  });

  it("matches think with no argument and consumes colon", () => {
    const res = extractThinkDirective("/think:");
    expect(res.hasDirective).toBe(true);
    expect(res.thinkLevel).toBeUndefined();
    expect(res.rawLevel).toBeUndefined();
    expect(res.cleaned).toBe("");
  });

  it("matches exec directive with options", () => {
    const res = extractExecDirective(
      "please /exec host=auto security=allowlist ask=on-miss node=mac-mini now",
    );
    expect(res.hasDirective).toBe(true);
    expect(res.execHost).toBe("auto");
    expect(res.execSecurity).toBe("allowlist");
    expect(res.execAsk).toBe("on-miss");
    expect(res.execNode).toBe("mac-mini");
    expect(res.cleaned).toBe("please now");
  });

  it.each([
    ["host", "spaceship", "execHost", "rawExecHost", "invalidHost"],
    ["security", "wide-open", "execSecurity", "rawExecSecurity", "invalidSecurity"],
    ["ask", "sometimes", "execAsk", "rawExecAsk", "invalidAsk"],
  ] as const)("captures invalid exec %s values", (option, value, field, rawField, invalidField) => {
    const res = extractExecDirective(`/exec ${option}=${value}`);
    expect(res.hasDirective).toBe(true);
    expect(res[field]).toBeUndefined();
    expect(res[rawField]).toBe(value);
    expect(res[invalidField]).toBe(true);
  });

  it.each(["-s harness=codex"])("parses /model runtime and session options from %s", (options) => {
    const model = parseInlineSessionDirectives(`/model openai/gpt-4.1-mini ${options}`, {
      command: { kind: "native", name: "model" },
    });

    expect(model.cleaned).toBe("");
    expect(model.rawModelDirective).toBe("openai/gpt-4.1-mini");
    expect(model.rawModelRuntime).toBe("codex");
    expect(model.modelScope).toBe("session");
    expect(model.command).toEqual({ name: "model" });
  });

  it("preserves spacing when stripping think directives before paths", () => {
    const res = extractThinkDirective("thats not /think high/tmp/hello");
    expect(res.hasDirective).toBe(true);
    expect(res.cleaned).toBe("thats not /tmp/hello");
  });

  it("parses queue options and modes", () => {
    const res = extractQueueDirective("please /queue collect debounce:2s cap:5 drop:summarize now");
    expect(res.hasDirective).toBe(true);
    expect(res.queueMode).toBe("collect");
    expect(res.debounceMs).toBe(2000);
    expect(res.cap).toBe(5);
    expect(res.dropPolicy).toBe("summarize");
    expect(res.cleaned).toBe("please now");
  });
});

describe("typed level directives accept digit and underscore aliases", () => {
  it.each([
    ["think", "think_hard", "thinkLevel", "low", ""],
    ["reasoning", "0", "reasoningLevel", "off", ""],
    ["verbose", "3d printing tips", "verboseLevel", undefined, "3d printing tips"],
  ] as const)("/%s %s", (name, args, levelKey, level, cleaned) => {
    const parsed = parseInlineSessionDirectives(`/${name} ${args}`, {
      command: { kind: "text", name },
    });

    expect(parsed[levelKey]).toBe(level);
    expect(parsed.cleaned).toBe(cleaned);
  });
});

describe("native directive commands own their complete argument boundary", () => {
  it.each([
    ["trace", "rawTraceLevel", "banana", "please"],
    ["elevated", "rawElevatedLevel", "perhaps", "explain"],
  ] as const)(
    "preserves the invalid first argument for native /%s",
    (command, rawKey, invalidArgument, trailingArguments) => {
      const parsed = parseInlineSessionDirectives(
        `/${command} ${invalidArgument} ${trailingArguments}`,
        { command: { kind: "native", name: command } },
      );

      expect(parsed[rawKey]).toBe(invalidArgument);
      expect(parsed.cleaned).toBe(trailingArguments);
      expect(parsed.command).toEqual({
        name: command,
        unconsumedArguments: trailingArguments,
      });
    },
  );

  it("does not interpret another directive inside native command arguments", () => {
    const parsed = parseInlineSessionDirectives("/queue /think high", {
      command: { kind: "native", name: "queue" },
    });

    expect(parsed.hasQueueDirective).toBe(true);
    expect(parsed.rawQueueMode).toBe("/think");
    expect(parsed.hasThinkDirective).toBe(false);
  });

  it("preserves the existing prose interpretation for ordinary inline directives", () => {
    const parsed = parseInlineSessionDirectives("/think about my deployment plan");

    expect(parsed.rawThinkLevel).toBeUndefined();
    expect(parsed.command).toBeUndefined();
    expect(parsed.cleaned).toBe("about my deployment plan");
  });
});
