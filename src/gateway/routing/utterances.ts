/**
 * utterances.ts — Semantic Router 示例话语库
 *
 * 为每个 TaskType 定义 20-25 条高质量示例话语（中英混合）。
 * 质量是准确率的关键：覆盖直接指令、间接表达、口语化/模糊表达、英文表达和对抗样本。
 *
 * 说明：
 * - FALLBACK 刻意扩充至 50+ 条，覆盖闲聊、确认、感叹、日常对话和边界样本
 * - 对抗样本（如"改天聊"→FALLBACK、"看下我写的对不对不用改"→CODE_REVIEW）帮助路由器避免误分类
 */

import { TaskType } from "./types.js";

export const ROUTE_UTTERANCES: Map<TaskType, string[]> = new Map([
  [
    TaskType.CODE_EDIT,
    [
      // 直接指令
      "帮我实现这个新功能",
      "在这个文件里加一个方法",
      "新增一个 API endpoint",
      "给这个类加个属性",
      "帮我写这部分的实现",
      // 口语化/模糊表达
      "这个搞一下",
      "把那块弄好",
      "加个东西进去",
      "这里要改改",
      "处理一下这块",
      "做一下这个功能",
      "这块逻辑需要补充一下",
      "这个功能还没写，帮我做一下",
      // 自然英文
      "implement the new feature",
      "add a function to handle this",
      "write code for the payment module",
      "create a new component for the sidebar",
      "add error handling to this function",
      "can you whip up a quick function for this",
      "let's add support for dark mode",
      "tweak this to handle the edge case",
      "wire up this endpoint",
    ],
  ],

  [
    TaskType.CODE_REVIEW,
    [
      // 直接指令
      "帮我看看这段代码有没有问题",
      "review 一下我的 PR",
      "帮我做个 code review",
      "代码写得怎么样，有改进空间吗",
      "看看这个实现是否合理",
      "帮我审查一下这份代码",
      // 口语化/模糊表达
      "帮我瞅瞅这个",
      "看下这样写对不对",
      "这样写行吗",
      "这个实现有没有什么坑",
      "有没有更好的写法",
      "看看有没有性能问题",
      // 对抗样本（明确只看不改）
      "看下我写的对不对，不用改",
      // 自然英文
      "review this pull request before merging",
      "check my code for potential issues",
      "is this implementation correct?",
      "review the changes I made to the API",
      "does this look right to you",
      "any obvious issues with this approach",
      "let me know if anything looks off",
      "glance over this and tell me if I'm missing anything",
    ],
  ],

  [
    TaskType.CODE_REFACTOR,
    [
      // 直接指令
      "这段代码太乱了，帮我重构一下",
      "重构这个模块，提高可读性",
      "代码结构需要整理",
      "把重复代码提取出来",
      "优化这部分的代码结构",
      "这块代码耦合太重，需要解耦",
      "帮我把这个大函数拆小",
      // 口语化
      "代码里有太多重复，重构一下",
      "这坨代码太难看了，整理一下",
      "这个函数太长了，拆成几个",
      // 自然英文
      "refactor the auth module to be cleaner",
      "extract this logic into a separate function",
      "reorganize the codebase structure",
      "restructure the data layer",
      "simplify this complex function",
      "clean up this messy code",
      "this code is getting hard to maintain",
      "the logic here is too tangled, help me untangle it",
      "split this into smaller pieces",
      "remove duplicate code across these files",
    ],
  ],

  [
    TaskType.CODE_DEBUG,
    [
      // 直接指令
      "程序报错了，帮我看看",
      "这里有个 bug 搞不定",
      "运行时崩溃，怎么回事",
      "排查一下这个问题",
      "找一下为什么这段逻辑不对",
      "程序行为不符合预期，帮我调试",
      "这个接口返回了错误，帮我定位",
      "production 报错了，紧急排查",
      "帮我找出为什么测试一直失败",
      // 口语化/模糊表达
      "怎么又挂了",
      "跑不起来了",
      "这个咋回事",
      "出问题了",
      "编译报错了看下",
      // 对抗样本（功能对但结果不对 → 仍是 debug）
      "代码跑不通但我不知道哪里错了",
      "功能正常但结果不对",
      // 自然英文
      "there's an error I can't figure out",
      "the app crashes when I do this",
      "debug this null pointer exception",
      "fix this runtime error",
      "it's broken again",
      "why is this returning null",
      "something's off with this output",
    ],
  ],

  [
    TaskType.DOC_WRITE,
    [
      // 直接指令
      "帮我写这个接口的文档",
      "更新一下 README",
      "写一份使用说明",
      "这个功能需要写文档",
      "帮我补充 CHANGELOG",
      "这里缺少注释，帮我加上",
      "写一份技术设计文档",
      "帮我写 API 参考文档",
      "把这次改动加到 changelog 里",
      // 口语化
      "写个说明",
      "补个文档",
      "加点注释",
      // 自然英文
      "write documentation for this API",
      "update the README with setup instructions",
      "create a user guide for this feature",
      "document the configuration options",
      "create an architecture doc",
      "write up how this feature works",
      "jot down the setup steps somewhere",
      "can you document this properly",
    ],
  ],

  [
    TaskType.DOC_REVIEW,
    [
      // 直接指令
      "帮我看看这份文档写得怎么样",
      "review 一下这篇技术文档",
      "文档有没有表述不清楚的地方",
      "这份设计文档逻辑通顺吗",
      "文档是否遗漏了什么关键信息",
      "这个说明写得太复杂了，看看怎么简化",
      "帮我审阅一下这篇接口文档",
      // 口语化
      "文档写清楚了吗",
      "这个 README 看得懂吗",
      "文档有没有什么不准确的地方",
      // 自然英文
      "check if this documentation is accurate",
      "review the README for clarity",
      "help me proofread this spec document",
      "is this technical doc easy to understand?",
      "check the API docs for completeness",
      "does this doc make sense",
      "is my explanation clear enough",
      "give this doc a quick read",
      "look over the technical spec",
      "make sure this guide is accurate",
    ],
  ],

  [
    TaskType.VISUAL_CRITIQUE,
    [
      // 直接指令
      "帮我看看这个界面设计得怎么样",
      "截图分析一下 UI 问题",
      "这个页面的视觉效果如何",
      "看看这张截图，布局有问题吗",
      "UI 对齐没有对齐，帮我检查",
      "界面颜色搭配合不合理",
      "帮我评估一下这个设计稿",
      "用户体验角度看这个界面有什么问题",
      "是否符合设计规范",
      "这个按钮放这里合适吗",
      // 自然英文
      "critique this UI design",
      "analyze this screenshot for visual issues",
      "does this interface look good?",
      "check the visual hierarchy of this page",
      "review the layout of this component",
      "this looks off, what's wrong with it",
      "does this match the design system",
      "is this accessible",
      "the spacing feels weird here",
      "tell me what looks bad about this UI",
    ],
  ],

  [
    TaskType.VISUAL_GENERATE,
    [
      // 直接指令
      "帮我生成一张图片",
      "画一个 logo",
      "生成一个图标",
      "帮我画一张配图",
      "帮我做一张封面图",
      "画一下这个流程的示意图",
      "生成一个架构图",
      "帮我画个流程图",
      // 自然英文
      "create an illustration for this concept",
      "generate an image of a mountain landscape",
      "design a banner for the website",
      "generate a social media image",
      "make an icon for this feature",
      "create a diagram showing the architecture",
      "draw a flowchart for this process",
      "generate a thumbnail image",
      "make me a hero image",
      "visualize this data as a chart",
      "create a mock UI screenshot",
      "illustrate this concept for the presentation",
    ],
  ],

  [
    TaskType.HEARTBEAT_CHECK,
    [
      // 直接指令
      "系统状态怎么样",
      "检查一下心跳",
      "服务还在运行吗",
      "运行状态正常吗",
      "做个健康检查",
      "看看有没有什么异常",
      "监控状态如何",
      "服务有没有挂",
      "各个进程都活着吗",
      "检查一下所有服务的状态",
      // 自然英文
      "check system health status",
      "is the service still running?",
      "run a heartbeat check",
      "ping the service to see if it's alive",
      "check if everything is healthy",
      "verify all services are up",
      "anything unusual in the logs",
      "are all the containers running",
      "status check, everything okay",
      "do a quick sanity check on the system",
    ],
  ],

  [
    TaskType.SECURITY_AUDIT,
    [
      // 直接指令
      "帮我做一次安全审计",
      "检查代码有没有安全漏洞",
      "这里有没有 SQL 注入风险",
      "审查一下依赖包的安全性",
      "检查 XSS 漏洞",
      "这个接口有没有权限问题",
      "加密方式是否安全",
      "帮我找出可能被攻击的地方",
      // 口语化
      "有没有安全隐患",
      "会不会被注入",
      "这个认证逻辑有没有漏洞",
      "用户输入有没有做校验",
      // 自然英文
      "run a security audit on the codebase",
      "check for vulnerabilities in dependencies",
      "review the authentication logic for weaknesses",
      "check for security issues in this endpoint",
      "scan for common security vulnerabilities",
      "verify input validation is secure",
      "is this API endpoint protected properly",
      "are there any XSS risks here",
      "check if tokens are handled securely",
      "is the data properly sanitized",
    ],
  ],

  [
    TaskType.SHELL_SCRIPT,
    [
      // 直接指令
      "帮我写个 bash 脚本",
      "写一个自动化部署脚本",
      "用 shell 写个备份脚本",
      "帮我写一个 cron 定时任务",
      "写个脚本来批量处理文件",
      "帮我写个 npm 发布脚本",
      "用脚本批量重命名文件",
      "写个脚本检查磁盘空间",
      // 口语化
      "写个脚本跑一下",
      "帮我整个脚本自动化这事",
      "搞个自动化脚本",
      // 自然英文
      "write a bash script to automate deployment",
      "create a shell script to clean up logs",
      "write a zsh function to simplify this workflow",
      "write a startup script for the server",
      "create a monitoring script",
      "automate this task with a shell script",
      "write a quick script to parse this log file",
      "help me automate this manual process",
      "create a setup script for new developers",
    ],
  ],

  [
    TaskType.GIT_OPS,
    [
      // 直接指令
      "帮我提交这次代码",
      "把这个分支 rebase 到 main",
      "创建一个新分支",
      "合并这个 PR",
      "解决 merge conflict",
      "回滚到上一个 commit",
      "cherry-pick 这个 commit",
      "帮我整理一下 git history",
      "帮我打一个 release tag",
      "帮我提个 PR",
      // 口语化
      "推一下",
      "提交一下",
      "合一下",
      "拉一下最新的",
      "这个分支需要 rebase",
      // 自然英文
      "commit and push these changes",
      "rebase onto the main branch",
      "create a PR for this feature",
      "squash commits before merging",
      "push to the remote repository",
      "merge this feature branch",
      "tag this release",
    ],
  ],

  [
    TaskType.TEST_WRITE,
    [
      // 直接指令
      "帮我写测试用例",
      "写单元测试",
      "给这个函数写 spec",
      "用 vitest 写测试",
      "这个功能缺测试，补一下",
      "测试覆盖率太低了，帮我提升",
      "这个边界条件没有测试覆盖",
      // 口语化
      "补个测试",
      "覆盖率不够",
      "这块覆盖率不够，加些测试",
      // 自然英文
      "add test coverage for this module",
      "write unit tests for the auth service",
      "create integration tests for the API",
      "add jest tests for the utility functions",
      "帮我写 E2E 测试",
      "write a test to verify this edge case",
      "create mock tests for the database layer",
      "write tests for the happy path and edge cases",
      "make sure this is covered by tests",
      "we need test coverage here",
    ],
  ],

  [
    TaskType.TEST_RUN,
    [
      // 直接指令
      "跑一下测试",
      "执行测试套件",
      "运行所有单元测试",
      "看看测试通不通过",
      "跑一遍 vitest",
      "帮我验证测试是否全部通过",
      "测试跑完了吗，结果怎样",
      // 口语化
      "跑一下看看",
      "测试过了没",
      "能跑通吗",
      // 对抗样本（只跑不写 → TEST_RUN 而非 TEST_WRITE）
      "测试跑一下就行，不用写新的",
      // 自然英文
      "run the test suite",
      "execute all tests",
      "check if tests are passing",
      "run vitest for this module",
      "run the CI test pipeline locally",
      "execute npm test and report results",
      "run the failing test again",
      "just run the tests, don't add new ones",
      "let me know if all tests pass",
    ],
  ],

  [
    TaskType.QUERY_READ,
    [
      // 直接指令
      "查一下这个数据",
      "从数据库读取用户信息",
      "查询这张表的数据",
      "帮我写一个查询语句",
      "从 API 获取这些数据",
      "查一下有多少条记录",
      "从缓存读取数据",
      "帮我写个数据查询",
      "把这些数据查出来",
      "帮我查一下这条记录在不在",
      // 自然英文
      "fetch data from the database",
      "query the users table",
      "write a SELECT statement for this",
      "get the latest entries from the database",
      "retrieve the config from the store",
      "read data from this collection",
      "look up the user by ID",
      "query for records matching this criteria",
      "pull all records from this week",
      "check if this entry exists in the database",
    ],
  ],

  [
    TaskType.QUERY_WRITE,
    [
      // 直接指令
      "往数据库写入这条记录",
      "更新用户的状态",
      "插入一条新数据",
      "删除这些过期记录",
      "写个 INSERT 语句",
      "批量插入这些数据",
      "帮我写 UPDATE SQL",
      "把这些数据保存到数据库",
      "把这条记录删掉",
      "更新一下这个字段",
      // 自然英文
      "insert a new record into the database",
      "update the user status in the DB",
      "write data to the cache",
      "delete old logs from the database",
      "write a migration to add this column",
      "upsert this record",
      "bulk insert these rows",
      "remove expired sessions from the DB",
      "save these changes to the database",
      "update multiple records at once",
    ],
  ],

  [
    TaskType.TRANSLATION,
    [
      // 直接指令
      "把这段话翻译成英文",
      "翻译一下这个错误信息",
      "把 UI 文案本地化",
      "帮我把中文翻译成日文",
      "i18n 这些字符串",
      "把这份文档翻译成中文",
      "这些 label 需要翻译",
      "帮我做多语言支持",
      "把这段英文翻译一下",
      "翻译这个界面的所有文案",
      // 自然英文
      "translate this text to English",
      "localize the UI strings",
      "translate the error messages",
      "convert this to Spanish",
      "internationalize the app strings",
      "translate the README to Chinese",
      "get this into French",
      "help me translate this paragraph",
      "add Chinese translation for these strings",
      "make this work in multiple languages",
    ],
  ],

  [
    TaskType.SCAFFOLD,
    [
      // 直接指令
      "帮我搭一个新项目的骨架",
      "生成一个 Vue 组件模板",
      "用脚手架创建一个 Express 应用",
      "初始化一个新的 React 项目",
      "生成样板代码",
      "帮我初始化项目结构",
      "帮我建一套标准项目模板",
      // 口语化
      "起个新项目",
      "建个新仓库",
      "init 一下这个项目",
      // 自然英文
      "scaffold a new Express project",
      "create a boilerplate for a React component",
      "generate starter code for this feature",
      "set up the project skeleton",
      "bootstrap a new TypeScript project",
      "generate the file structure for this module",
      "create a template for the API service",
      "spin up a new project from scratch",
      "create the basic project structure",
      "set me up with a starter template",
    ],
  ],

  [
    TaskType.CI_DEBUG,
    [
      // 直接指令
      "CI 挂了，帮我排查",
      "GitHub Actions 报错了",
      "流水线失败，是什么问题",
      "帮我搞定 CI 失败",
      "pipeline 跑不过去",
      "帮我分析 CI 日志",
      "CI 一直失败，帮我看一下",
      // 口语化
      "CI 又红了",
      "build 挂了",
      "deploy 失败了",
      // 自然英文
      "CI pipeline is failing",
      "GitHub Actions workflow is broken",
      "fix the CI build error",
      "the build fails on the lint step",
      "why is the pipeline failing?",
      "diagnose the failing GitHub Actions job",
      "help me fix the broken deployment pipeline",
      "our CD pipeline is stuck",
      "the linter is blocking the merge",
      "tests are failing in CI but passing locally",
    ],
  ],

  [
    TaskType.MEMORY_UPDATE,
    [
      // 直接指令
      "更新记忆文件",
      "把今天的工作记录下来",
      "写入 MEMORY.md",
      "更新日常工作日志",
      "把这个教训记录到 memory 里",
      "帮我把这个架构决定记录下来",
      "把这次 bug 记录进 memory 作为教训",
      "记录这次的调试过程",
      // 口语化
      "记一下",
      "存到记忆里",
      "别忘了这个",
      "把这个存下来",
      // 自然英文
      "update the MEMORY.md with today's lessons",
      "write today's session notes",
      "record this decision in memory",
      "update the daily memory log",
      "flush memory before session ends",
      "write a session summary to memory",
      "note this down for later",
      "make sure we remember this decision",
    ],
  ],

  [
    TaskType.PLANNING,
    [
      // 直接指令
      "帮我制定实现计划",
      "设计一下这个功能的架构",
      "规划一下接下来的开发步骤",
      "帮我做一份技术方案",
      "怎么设计这个系统比较好",
      "帮我想想怎么实现比较合理",
      "帮我分析一下技术选型",
      "帮我做一个实现路线图",
      // 口语化
      "想想怎么搞",
      "先理一下思路",
      "规划一下",
      "这个怎么做比较好",
      "我们来规划下一步",
      "这个功能怎么拆分比较好",
      // 自然英文
      "design the architecture for this system",
      "plan the implementation steps",
      "create a technical design document",
      "what's the best approach for this feature?",
      "outline the development roadmap",
      "plan the migration strategy",
      "design the data model for this feature",
      "let's think about how to approach this",
      "what's the game plan here",
    ],
  ],

  [
    TaskType.REASONING,
    [
      // 直接指令
      "分析一下这个问题的根本原因",
      "帮我推理一下为什么会这样",
      "这个问题的逻辑是什么",
      "从原理上解释一下这个现象",
      "帮我系统性地思考这个问题",
      "帮我深入分析这个技术决策",
      "从多角度分析这个方案",
      // "为什么"类问题
      "为什么会出现这个情况",
      "为什么这么设计",
      "这两个方案哪个更好，为什么",
      "解释一下这背后的原理",
      "帮我权衡一下这几个选项",
      // 自然英文
      "reason through this problem step by step",
      "analyze the root cause of this issue",
      "explain the underlying logic",
      "think through the trade-offs",
      "what are the pros and cons of each approach?",
      "help me think through this complex problem",
      "walk me through the reasoning",
      "compare these two approaches in depth",
      "why does this behave this way",
      "break this down for me",
    ],
  ],

  [
    TaskType.MULTIMODAL_ANALYSIS,
    [
      // 直接指令
      "帮我分析这张图片",
      "从这个视频里提取信息",
      "分析这份音频内容",
      "看看这张图表说明了什么",
      "读取这个 PDF 的内容",
      "帮我解读这张数据图",
      "从这个截图里提取文字",
      // 口语化/具体场景
      "帮我分析一下这个截图里的问题",
      "这张图里写了什么",
      "扫一下这张图表的数据",
      "看一下这段视频里说了什么",
      // 自然英文
      "analyze this image",
      "extract information from this screenshot",
      "what does this diagram show?",
      "analyze the chart in this image",
      "interpret this visual data",
      "analyze the content of this video",
      "read and summarize this document",
      "tell me what's in this screenshot",
      "parse the data from this chart",
    ],
  ],
]);
// NOTE: TaskType.FALLBACK is intentionally excluded from ROUTE_UTTERANCES.
// The semantic router should only match positive task routes; FALLBACK is
// returned by task-resolver.ts when no route score exceeds the threshold.
// Casual/adversarial samples are handled implicitly by the low-similarity
// nature of non-technical messages against all task route embeddings.
