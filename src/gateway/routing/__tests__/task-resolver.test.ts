import { describe, expect, it } from "vitest";
import { SemanticRouter } from "../semantic-router.js";
import { resolveTaskType } from "../task-resolver.js";
import { TaskType } from "../types.js";

describe("resolveTaskType - L1 keyword rules", () => {
  it("CODE_DEBUG: matches 'fix'", async () => {
    expect(await resolveTaskType("Please fix the crash in login")).toBe(TaskType.CODE_DEBUG);
  });

  it("CODE_DEBUG: matches 'bug'", async () => {
    expect(await resolveTaskType("There is a bug in the parser")).toBe(TaskType.CODE_DEBUG);
  });

  it("CODE_DEBUG: matches 'exception'", async () => {
    expect(await resolveTaskType("Got an exception when calling the API")).toBe(
      TaskType.CODE_DEBUG,
    );
  });

  it("CODE_REFACTOR: matches 'refactor'", async () => {
    expect(await resolveTaskType("refactor the auth module")).toBe(TaskType.CODE_REFACTOR);
  });

  it("CODE_REFACTOR: matches '重构'", async () => {
    expect(await resolveTaskType("需要重构这个模块")).toBe(TaskType.CODE_REFACTOR);
  });

  it("TEST_WRITE: matches 'vitest'", async () => {
    expect(await resolveTaskType("write vitest tests for the store")).toBe(TaskType.TEST_WRITE);
  });

  it("TEST_WRITE: matches 'jest'", async () => {
    expect(await resolveTaskType("add jest coverage for utils")).toBe(TaskType.TEST_WRITE);
  });

  it("TEST_WRITE: matches '测试'", async () => {
    expect(await resolveTaskType("写测试覆盖这个功能")).toBe(TaskType.TEST_WRITE);
  });

  it("GIT_OPS: matches 'commit'", async () => {
    expect(await resolveTaskType("commit the changes and push")).toBe(TaskType.GIT_OPS);
  });

  it("GIT_OPS: matches 'rebase'", async () => {
    expect(await resolveTaskType("rebase onto main")).toBe(TaskType.GIT_OPS);
  });

  it("TRANSLATION: matches 'translate'", async () => {
    expect(await resolveTaskType("translate this string to Chinese")).toBe(TaskType.TRANSLATION);
  });

  it("TRANSLATION: matches '翻译'", async () => {
    expect(await resolveTaskType("翻译以下内容")).toBe(TaskType.TRANSLATION);
  });

  it("DOC_WRITE: matches 'README'", async () => {
    expect(await resolveTaskType("update the README with new examples")).toBe(TaskType.DOC_WRITE);
  });

  it("DOC_WRITE: matches 'changelog'", async () => {
    expect(await resolveTaskType("update changelog for v2.0")).toBe(TaskType.DOC_WRITE);
  });

  it("CODE_REVIEW: matches 'review'", async () => {
    expect(await resolveTaskType("review this PR before merging")).toBe(TaskType.CODE_REVIEW);
  });

  it("SCAFFOLD: matches 'scaffold'", async () => {
    expect(await resolveTaskType("scaffold a new Express project")).toBe(TaskType.SCAFFOLD);
  });

  it("SCAFFOLD: matches 'boilerplate'", async () => {
    expect(await resolveTaskType("generate boilerplate for a Vue component")).toBe(
      TaskType.SCAFFOLD,
    );
  });

  it("CI_DEBUG: matches 'CI'", async () => {
    expect(await resolveTaskType("CI pipeline is failing on lint step")).toBe(TaskType.CI_DEBUG);
  });

  it("SECURITY_AUDIT: matches 'vulnerability'", async () => {
    expect(await resolveTaskType("check for vulnerability in deps")).toBe(TaskType.SECURITY_AUDIT);
  });

  it("SECURITY_AUDIT: matches '安全'", async () => {
    expect(await resolveTaskType("做一次安全审计")).toBe(TaskType.SECURITY_AUDIT);
  });

  it("SHELL_SCRIPT: matches 'bash'", async () => {
    expect(await resolveTaskType("write a bash script to deploy")).toBe(TaskType.SHELL_SCRIPT);
  });

  it("MEMORY_UPDATE: matches 'memory'", async () => {
    expect(await resolveTaskType("update memory with today's session")).toBe(
      TaskType.MEMORY_UPDATE,
    );
  });

  it("MEMORY_UPDATE: matches 'MEMORY.md'", async () => {
    expect(await resolveTaskType("write MEMORY.md for this lesson")).toBe(TaskType.MEMORY_UPDATE);
  });

  it("PLANNING: matches 'architecture'", async () => {
    expect(await resolveTaskType("design the architecture for the new module")).toBe(
      TaskType.PLANNING,
    );
  });

  it("PLANNING: matches '计划'", async () => {
    expect(await resolveTaskType("制定计划来实现这个功能")).toBe(TaskType.PLANNING);
  });

  it("VISUAL_CRITIQUE: matches 'screenshot'", async () => {
    expect(await resolveTaskType("take a screenshot and review")).toBe(TaskType.VISUAL_CRITIQUE);
  });

  it("VISUAL_CRITIQUE: matches 'UI'", async () => {
    expect(await resolveTaskType("check the UI alignment")).toBe(TaskType.VISUAL_CRITIQUE);
  });

  it("HEARTBEAT_CHECK: matches 'heartbeat'", async () => {
    expect(await resolveTaskType("run heartbeat check")).toBe(TaskType.HEARTBEAT_CHECK);
  });

  it("HEARTBEAT_CHECK: matches '心跳'", async () => {
    expect(await resolveTaskType("检查心跳状态")).toBe(TaskType.HEARTBEAT_CHECK);
  });

  it("CODE_EDIT: matches 'implement'", async () => {
    expect(await resolveTaskType("implement the new feature for routing")).toBe(TaskType.CODE_EDIT);
  });

  it("CODE_EDIT: matches '实现'", async () => {
    expect(await resolveTaskType("实现这个新功能")).toBe(TaskType.CODE_EDIT);
  });

  it("FALLBACK: no keyword matches", async () => {
    expect(await resolveTaskType("hello world")).toBe(TaskType.FALLBACK);
  });

  it("FALLBACK: empty string", async () => {
    expect(await resolveTaskType("")).toBe(TaskType.FALLBACK);
  });

  it("L1 priority: CODE_DEBUG before CODE_EDIT (fix appears before implement)", async () => {
    // 'fix' triggers CODE_DEBUG; even if 'implement' also appears, first match wins
    expect(await resolveTaskType("fix and implement the new feature")).toBe(TaskType.CODE_DEBUG);
  });

  it("case insensitive: 'FIX' matches CODE_DEBUG", async () => {
    expect(await resolveTaskType("FIX the issue")).toBe(TaskType.CODE_DEBUG);
  });

  // New keywords added in Phase 5
  it("CODE_DEBUG: matches '报错'", async () => {
    expect(await resolveTaskType("运行时报错了，帮我看看")).toBe(TaskType.CODE_DEBUG);
  });

  it("CODE_EDIT: matches '编码'", async () => {
    expect(await resolveTaskType("开始编码实现这个功能")).toBe(TaskType.CODE_EDIT);
  });

  it("SHELL_SCRIPT: 'sh' without trailing space still matches 'shell'", async () => {
    expect(await resolveTaskType("write a shell script")).toBe(TaskType.SHELL_SCRIPT);
  });

  it("MEMORY_UPDATE: '日志' no longer matches (removed from rules)", async () => {
    // '日志' was removed; should fall through to FALLBACK
    expect(await resolveTaskType("查看日志")).toBe(TaskType.FALLBACK);
  });

  // CJK keyword enhancements
  it("CODE_DEBUG: matches '调试'", async () => {
    expect(await resolveTaskType("调试这个问题")).toBe(TaskType.CODE_DEBUG);
  });

  it("CODE_DEBUG: matches '排错'", async () => {
    expect(await resolveTaskType("帮我排错，程序跑不起来")).toBe(TaskType.CODE_DEBUG);
  });

  it("CODE_REFACTOR: matches '优化代码' (not code_edit)", async () => {
    expect(await resolveTaskType("优化代码结构")).toBe(TaskType.CODE_REFACTOR);
  });

  it("CODE_REFACTOR: matches '整理代码'", async () => {
    expect(await resolveTaskType("整理代码，消除重复")).toBe(TaskType.CODE_REFACTOR);
  });

  it("TEST_WRITE: '写个测试' matches via '测试'", async () => {
    expect(await resolveTaskType("写个测试")).toBe(TaskType.TEST_WRITE);
  });

  it("TEST_WRITE: matches '加测试'", async () => {
    expect(await resolveTaskType("加测试覆盖这个逻辑")).toBe(TaskType.TEST_WRITE);
  });

  it("DOC_WRITE: matches '写文档'", async () => {
    expect(await resolveTaskType("帮我写文档说明接口")).toBe(TaskType.DOC_WRITE);
  });

  it("DOC_WRITE: matches '更新文档'", async () => {
    expect(await resolveTaskType("更新文档，同步最新改动")).toBe(TaskType.DOC_WRITE);
  });

  it("GIT_OPS: matches '提交'", async () => {
    expect(await resolveTaskType("帮我提交代码")).toBe(TaskType.GIT_OPS);
  });

  it("GIT_OPS: matches '合并'", async () => {
    expect(await resolveTaskType("把这个分支合并进主干")).toBe(TaskType.GIT_OPS);
  });

  it("GIT_OPS: matches '推送'", async () => {
    expect(await resolveTaskType("推送到远端仓库")).toBe(TaskType.GIT_OPS);
  });

  it("CODE_EDIT: matches '修改'", async () => {
    expect(await resolveTaskType("修改一下这个组件")).toBe(TaskType.CODE_EDIT);
  });

  it("CODE_EDIT: '改' matches when no earlier rule fires", async () => {
    expect(await resolveTaskType("帮我改这个函数的逻辑")).toBe(TaskType.CODE_EDIT);
  });

  it("CODE_EDIT: matches '加个'", async () => {
    expect(await resolveTaskType("帮我加个按钮")).toBe(TaskType.CODE_EDIT);
  });

  it("CODE_EDIT: matches '添加'", async () => {
    expect(await resolveTaskType("添加一个新的路由")).toBe(TaskType.CODE_EDIT);
  });

  it("CODE_EDIT: matches '增加'", async () => {
    expect(await resolveTaskType("增加错误处理逻辑")).toBe(TaskType.CODE_EDIT);
  });

  it("CODE_EDIT: matches '改一下'", async () => {
    expect(await resolveTaskType("改一下这里的实现")).toBe(TaskType.CODE_EDIT);
  });

  // Priority smoke tests for new CJK keywords
  it("L1 priority: '优化代码' → CODE_REFACTOR, not CODE_EDIT", async () => {
    // CODE_REFACTOR (rule #2) fires before CODE_EDIT (rule #16)
    expect(await resolveTaskType("优化代码结构")).toBe(TaskType.CODE_REFACTOR);
  });

  it("L1 priority: '改文档' → DOC_WRITE, not CODE_EDIT", async () => {
    // DOC_WRITE (rule #5) fires before CODE_EDIT (rule #16)
    expect(await resolveTaskType("改文档里的描述")).toBe(TaskType.DOC_WRITE);
  });

  it("L1 priority: '提交' → GIT_OPS, not CODE_EDIT", async () => {
    // GIT_OPS (rule #8) fires before CODE_EDIT (rule #16)
    expect(await resolveTaskType("提交这次修改")).toBe(TaskType.GIT_OPS);
  });
});

describe("resolveTaskType - L1.5 semantic router integration", () => {
  it("uses semantic router when L1 does not match", async () => {
    const mockRouter = {
      isInitialized: true,
      routeCount: 10,
      resolve: async (_text: string) => TaskType.CODE_EDIT,
      init: async () => {},
    };

    // Text that doesn't match any L1 keyword
    const result = await resolveTaskType(
      "这块逻辑有点奇怪",
      mockRouter as unknown as SemanticRouter,
    );
    expect(result).toBe(TaskType.CODE_EDIT);
  });

  it("L1 takes priority over semantic router", async () => {
    const mockRouter = {
      isInitialized: true,
      routeCount: 10,
      resolve: async (_text: string) => TaskType.CODE_EDIT,
      init: async () => {},
    };

    // 'fix' matches L1 → CODE_DEBUG, semantic router returns CODE_EDIT but is not called
    const result = await resolveTaskType("fix this bug", mockRouter as unknown as SemanticRouter);
    expect(result).toBe(TaskType.CODE_DEBUG);
  });

  it("returns FALLBACK when semantic router returns null", async () => {
    const mockRouter = {
      isInitialized: true,
      routeCount: 10,
      resolve: async (_text: string) => null,
      init: async () => {},
    };

    const result = await resolveTaskType(
      "random unrecognized text here",
      mockRouter as unknown as SemanticRouter,
    );
    expect(result).toBe(TaskType.FALLBACK);
  });

  it("returns FALLBACK when no semanticRouter provided and L1 does not match", async () => {
    const result = await resolveTaskType("random unrecognized text here");
    expect(result).toBe(TaskType.FALLBACK);
  });
});

describe("resolveTaskType - recentContext short-window enrichment", () => {
  it("passes concatenated recentContext+text to semantic router when L1 misses", async () => {
    // '好' does not match any L1 keyword → falls through to semantic router
    // The router should receive the full context string, not just '好'
    const capturedTexts: string[] = [];
    const mockRouter = {
      isInitialized: true,
      routeCount: 10,
      resolve: async (text: string) => {
        capturedTexts.push(text);
        return TaskType.CODE_EDIT;
      },
      init: async () => {},
    };

    const recentContext = "帮我写一个排序算法\n好的，我来实现";
    const result = await resolveTaskType(
      "好",
      mockRouter as unknown as SemanticRouter,
      recentContext,
    );

    expect(result).toBe(TaskType.CODE_EDIT);
    expect(capturedTexts).toHaveLength(1);
    // Router must receive "recentContext\ntext", not bare "好"
    expect(capturedTexts[0]).toBe(`${recentContext}\n好`);
  });

  it("L1 match with recentContext: keyword wins, semantic router is NOT called", async () => {
    // 'fix' triggers L1 → CODE_DEBUG; router should never be invoked
    let routerCalled = false;
    const mockRouter = {
      isInitialized: true,
      routeCount: 10,
      resolve: async (_text: string) => {
        routerCalled = true;
        return TaskType.CODE_EDIT;
      },
      init: async () => {},
    };

    const recentContext = "请帮我修一下这个问题";
    const result = await resolveTaskType(
      "fix the auth bug",
      mockRouter as unknown as SemanticRouter,
      recentContext,
    );

    expect(result).toBe(TaskType.CODE_DEBUG);
    expect(routerCalled).toBe(false);
  });

  it("recentContext=undefined: semantic router receives bare text (behavior unchanged)", async () => {
    const capturedTexts: string[] = [];
    const mockRouter = {
      isInitialized: true,
      routeCount: 10,
      resolve: async (text: string) => {
        capturedTexts.push(text);
        return TaskType.PLANNING;
      },
      init: async () => {},
    };

    const result = await resolveTaskType(
      "这块逻辑有点奇怪",
      mockRouter as unknown as SemanticRouter,
      undefined,
    );

    expect(result).toBe(TaskType.PLANNING);
    expect(capturedTexts).toHaveLength(1);
    // Without recentContext the text must be passed verbatim
    expect(capturedTexts[0]).toBe("这块逻辑有点奇怪");
  });
});
