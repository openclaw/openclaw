# Privacy Filter Module

OpenClaw 隐私过滤模块 — 在消息发送到 LLM API 之前自动检测并替换敏感信息，LLM 响应返回后自动还原，确保隐私数据不会泄露到外部服务。

## 目录

- [架构概览](#架构概览)
- [核心流程](#核心流程)
- [模块说明](#模块说明)
- [内置规则](#内置规则)
- [配置说明](#配置说明)
- [自定义规则](#自定义规则)
- [替换模板](#替换模板)
- [命名验证器](#命名验证器)
- [API 参考](#api-参考)

---

## 架构概览

```
用户输入 (含敏感信息)
     │
     ▼
 ┌──────────┐     ┌──────────┐     ┌──────────┐
 │ Detector │────▶│ Replacer │────▶│  Store   │
 │ 检测引擎  │     │ 替换引擎  │     │ 加密存储  │
 └──────────┘     └──────────┘     └──────────┘
     │                 │
     │   ┌─────────────┘
     ▼   ▼
 ┌──────────────┐
 │StreamWrapper │  ← 包装 LLM 调用流
 │ 出站: 替换    │
 │ 入站: 还原    │
 └──────────────┘
     │
     ▼
  LLM API (只看到替换后的内容)
```

## 核心流程

1. **检测 (Detect)** — `PrivacyDetector` 使用正则表达式、关键词匹配和上下文约束扫描文本，识别敏感信息
2. **替换 (Replace)** — `PrivacyReplacer` 将敏感内容替换为格式兼容的假值（如 `user@gmail.com` → `pf_e1234567890@example.net`），保持语义结构不变，LLM 仍能理解上下文
3. **存储 (Persist)** — `PrivacyMappingStore` 使用 AES-256-GCM 加密保存原文与替换值的映射关系
4. **还原 (Restore)** — LLM 响应中出现的替换值被自动还原为原始内容，用户看到的是真实信息

## 模块说明

| 文件                | 职责                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `types.ts`          | 所有类型定义：`PrivacyRule`、`DetectionMatch`、`PrivacyConfig`、`UserDefinedRule`、`CustomRulesConfig` 等 |
| `rules.ts`          | 内置规则集（`BASIC_RULES` 和 `EXTENDED_RULES`）及 `resolveRules()` 规则解析入口                           |
| `detector.ts`       | 检测引擎 `PrivacyDetector`：编译规则、正则匹配、上下文验证、密码复杂度和熵值校验                          |
| `replacer.ts`       | 替换引擎 `PrivacyReplacer`：生成类型特定的假值、维护双向映射、支持自定义模板                              |
| `mapping-store.ts`  | 加密持久化存储 `PrivacyMappingStore`：AES-256-GCM 加密、PBKDF2 密钥派生、按会话隔离                       |
| `stream-wrapper.ts` | LLM 调用流包装：拦截出站消息进行替换、拦截入站响应进行还原                                                |
| `custom-rules.ts`   | 自定义规则模块：从 JSON/JSON5 文件加载用户规则、验证、合并                                                |
| `index.ts`          | 公共 API 统一导出                                                                                         |

## 内置规则

### Basic 规则集

高优先级、低误报率的核心规则：

| 类型                        | 风险级别 | 说明                                      |
| --------------------------- | -------- | ----------------------------------------- |
| `email`                     | medium   | 电子邮箱地址                              |
| `phone_cn`                  | medium   | 中国大陆手机号                            |
| `id_card_cn`                | high     | 中国身份证号                              |
| `credit_card`               | critical | 信用卡号（Visa/MasterCard/Amex/Discover） |
| `bank_account_cn`           | critical | 中国银行账号（需上下文关键词）            |
| `password_assignment`       | critical | 密码赋值语句（`password=xxx`）            |
| `env_password`              | critical | 环境变量密码（`PASSWORD=xxx`）            |
| `github_token`              | critical | GitHub 访问令牌                           |
| `openai_api_key`            | critical | OpenAI API 密钥                           |
| `slack_token`               | critical | Slack 令牌                                |
| `google_api_key`            | critical | Google API 密钥                           |
| `stripe_api_key`            | critical | Stripe API 密钥                           |
| `aws_access_key`            | critical | AWS 访问密钥                              |
| `aws_secret_key`            | critical | AWS 秘密密钥                              |
| `alibaba_access_key`        | critical | 阿里云 AccessKey                          |
| `tencent_secret_id`         | critical | 腾讯云 SecretId                           |
| `jwt_token`                 | high     | JWT 令牌                                  |
| `generic_api_key`           | high     | 通用 API 密钥模式                         |
| `bearer_token`              | high     | Bearer 令牌                               |
| `ssh_private_key`           | critical | SSH 私钥                                  |
| `database_url_*`            | critical | MySQL/PostgreSQL/MongoDB 连接字符串       |
| `redis_url`                 | critical | Redis 连接字符串                          |
| `url_with_credentials`      | critical | 带凭证的 URL                              |
| `basic_auth`                | critical | HTTP Basic 认证                           |
| `social_security_number_us` | critical | 美国社保号                                |
| `bare_password`             | high     | 裸密码（3+ 字符类复杂度检测）             |
| `high_entropy_string`       | high     | 高熵字符串（可能是密钥/令牌）             |

### Extended 规则集（默认）

包含 Basic 全部规则，额外增加：

- 更多电话格式：香港、台湾、美国
- 更多证件：香港身份证、中国护照、多国护照
- 银联卡、IBAN
- 支付宝、微信 ID
- 更多 API 密钥：Anthropic、GitLab、Discord、NPM、PyPI、SendGrid、Twilio、Shopify、Square、New Relic、Mailchimp、Sentry
- Azure 存储密钥、Azure 客户端密钥
- JDBC、.NET 连接字符串、Elasticsearch、RabbitMQ
- OAuth 令牌、Session 令牌
- 加密货币私钥、以太坊地址
- 工资金额

---

## 配置说明

在 OpenClaw 配置文件中设置 `privacy` 字段：

```json5
{
  privacy: {
    // 是否启用隐私过滤（默认 true）
    enabled: true,

    // 规则集："basic" | "extended" | 自定义规则文件路径
    rules: "extended",

    // 加密设置
    encryption: {
      algorithm: "aes-256-gcm",
      salt: "", // 留空则自动生成
    },

    // 映射存储设置
    mappings: {
      ttl: 86400000, // 映射过期时间，默认 24 小时（毫秒）
      storePath: "", // 留空使用默认路径 ~/.openclaw/privacy/mappings.enc
    },

    // 日志设置
    log: {
      useReplacedContent: true, // 日志中使用替换后的内容
    },
  },
}
```

---

## 自定义规则

当内置规则无法满足需求时，可以通过 JSON/JSON5 文件定义自定义规则。

### 启用方式

将 `privacy.rules` 设置为自定义规则文件的路径：

```json
{
  "privacy": {
    "enabled": true,
    "rules": "./my-privacy-rules.json5"
  }
}
```

### 配置文件格式

```json5
{
  // 基础预设："basic" | "extended" | "none"
  // 自定义规则会在基础预设之上叠加
  // 默认 "extended"
  extends: "extended",

  // 要禁用的内置规则类型列表
  // 这些规则仍然存在，但 enabled 会被设为 false
  disable: ["bare_password", "high_entropy_string"],

  // 自定义规则列表
  rules: [
    // ... 规则定义
  ],
}
```

### 规则定义字段

```json5
{
  // [必填] 规则类型标识符，必须是 snake_case 格式（如 "employee_id"）
  type: "employee_id",

  // [必填] 人类可读的描述
  description: "内部员工编号 (EMP-XXXXXX)",

  // [必填] 风险级别："low" | "medium" | "high" | "critical"
  riskLevel: "medium",

  // [可选] 正则表达式模式（与 keywords 至少填一个）
  // 支持 (?i) 前缀表示不区分大小写
  pattern: "\\bEMP-[0-9]{6}\\b",

  // [可选] 关键词列表（与 pattern 至少填一个）
  keywords: ["Project-Phoenix", "Project-Titan"],

  // [可选] 关键词匹配是否区分大小写，默认 false
  caseSensitive: true,

  // [可选] 上下文约束，用于减少误报
  context: {
    mustContain: ["server", "host"], // 匹配区域附近必须出现的关键词（任意一个）
    mustNotContain: ["example", "test"], // 匹配区域附近不能出现的关键词
  },

  // [可选] 是否启用此规则，默认 true
  enabled: true,

  // [可选] 命名验证器函数，用于后置匹配验证
  // 可选值："bare_password" | "high_entropy"
  validateFn: "bare_password",

  // [可选] 自定义替换模板（详见"替换模板"章节）
  replacementTemplate: "EMP-REDACTED-{seq}",
}
```

### 完整示例

```json5
{
  extends: "basic",

  disable: [
    "bare_password", // 关闭裸密码检测（误报率高）
    "high_entropy_string", // 关闭高熵字符串检测
  ],

  rules: [
    // 1. 新增：公司员工编号
    {
      type: "employee_id",
      description: "内部员工编号 (EMP-XXXXXX)",
      riskLevel: "medium",
      pattern: "\\bEMP-[0-9]{6}\\b",
      replacementTemplate: "EMP-000{seq}00",
    },

    // 2. 新增：日本电话号码
    {
      type: "phone_jp",
      description: "日本手机号码",
      riskLevel: "medium",
      pattern: "\\b0[789]0-?\\d{4}-?\\d{4}\\b",
    },

    // 3. 覆盖内置规则：将 email 风险级别降低
    {
      type: "email",
      description: "Email address (低风险)",
      riskLevel: "low",
      pattern: "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b",
    },

    // 4. 关键词检测：内部项目代号
    {
      type: "internal_codename",
      description: "内部项目代号",
      riskLevel: "high",
      keywords: ["Project-Phoenix", "Project-Titan", "Project-Nova"],
      caseSensitive: true,
    },

    // 5. 带上下文约束：仅在特定上下文中检测 IP
    {
      type: "server_ip",
      description: "服务器 IP 地址",
      riskLevel: "medium",
      pattern: "\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b",
      context: {
        mustContain: ["server", "host", "服务器", "节点"],
        mustNotContain: ["example", "localhost"],
      },
    },
  ],
}
```

### 合并规则

- **同 type 覆盖**：自定义规则中与内置规则 `type` 相同的规则会**整体替换**内置规则（不是部分合并）
- **新 type 追加**：内置规则中不存在的 type 会追加到规则列表末尾
- **disable 列表**：被禁用的规则仍存在于列表中，但 `enabled` 被设为 `false`

### 验证规则

自定义规则在加载时会进行以下验证：

| 检查项         | 说明                                                         |
| -------------- | ------------------------------------------------------------ |
| `type` 格式    | 必须匹配 `[a-z][a-z0-9_]*`（小写 snake_case）                |
| 必填字段       | `type`、`description`、`riskLevel` 不能为空                  |
| `riskLevel` 值 | 必须是 `low` / `medium` / `high` / `critical` 之一           |
| 匹配方式       | `pattern` 和 `keywords` 至少提供一个                         |
| 正则安全性     | 模式必须可编译、长度不超过 2000 字符、无嵌套量词（防 ReDoS） |
| `validateFn`   | 如果提供，必须是已注册的命名验证器                           |

验证失败的规则会被跳过（不会导致整体加载失败），错误信息通过 `console.warn` 输出。

---

## 替换模板

自定义规则可以通过 `replacementTemplate` 字段定义替换值的格式。

### 支持的占位符

| 占位符                | 说明                          | 示例值                                             |
| --------------------- | ----------------------------- | -------------------------------------------------- |
| `{type}`              | 规则类型标识符                | `employee_id`                                      |
| `{seq}`               | 本次会话内的序号（从 0 递增） | `0`, `1`, `2`                                      |
| `{ts}`                | 时间戳后 10 位                | `1234567890`                                       |
| `{original_prefix:N}` | 原始内容的前 N 个字符         | 原文 `EMP-123456` → `{original_prefix:4}` = `EMP-` |
| `{original_length}`   | 原始内容的长度                | `10`                                               |
| `{pad:N}`             | N 个 `x` 字符填充             | `{pad:5}` = `xxxxx`                                |

### 模板示例

```json5
// 员工编号：保留前缀，序号填充
"replacementTemplate": "EMP-{seq}00000"
// EMP-123456 → EMP-000000

// 保留原始前缀
"replacementTemplate": "{original_prefix:4}XXXX-0000"
// INT-ABCD-1234 → INT-XXXX-0000

// 通用脱敏，保留类型标记
"replacementTemplate": "REDACTED_{type}_{seq}"
// 任意匹配 → REDACTED_employee_id_0

// 固定长度填充
"replacementTemplate": "***{pad:10}***"
// 任意匹配 → ***xxxxxxxxxx***
```

如果未提供 `replacementTemplate`，系统会使用内置的类型特定替换逻辑（如邮箱生成假邮箱、电话生成假电话等），或对未知类型使用通用格式 `pf_{type}_{timestamp}{seq}`。

---

## 命名验证器

由于 JSON 配置文件无法包含函数，自定义规则通过 `validateFn` 字段引用预注册的命名验证器。

### 内置验证器

| 名称            | 说明                                                                              |
| --------------- | --------------------------------------------------------------------------------- |
| `bare_password` | 检查字符串是否具有密码特征（3+ 字符类、8-64 字符、排除 URL/路径等常见误报）       |
| `high_entropy`  | 检查字符串是否为高熵随机串（Shannon 熵 ≥ 3.5 bits/char、≥ 16 字符、排除顺序字符） |

### 注册自定义验证器

插件或扩展可以通过 API 注册新的验证器：

```typescript
import { registerNamedValidator } from "./privacy/index.js";

// 注册一个自定义验证器
registerNamedValidator("luhn_check", (s: string) => {
  // Luhn 算法校验（信用卡号）
  let sum = 0;
  let alternate = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let n = parseInt(s[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
});
```

之后在自定义规则中引用：

```json5
{
  type: "custom_card",
  description: "自定义卡号检测",
  riskLevel: "critical",
  pattern: "\\b\\d{16}\\b",
  validateFn: "luhn_check",
}
```

---

## API 参考

### 核心类

#### `PrivacyDetector`

```typescript
// 使用预设
const detector = new PrivacyDetector("extended");

// 使用自定义规则数组
const detector = new PrivacyDetector(customRules);

// 检测
const result: FilterResult = detector.detect("text with sensitive@email.com");
// result.hasPrivacyRisk → true
// result.matches → [{ type: "email", content: "sensitive@email.com", ... }]

// 快速检查
const hasSensitive: boolean = detector.check("some text");
```

#### `PrivacyReplacer`

```typescript
const replacer = new PrivacyReplacer("session-id");

// 替换检测到的敏感内容
const { replaced, newMappings } = replacer.replaceAll(text, matches);

// 还原替换内容
const original = replacer.restore(replacedText);
```

#### `PrivacyMappingStore`

```typescript
const store = new PrivacyMappingStore({ salt: "my-salt" });

store.save(mappings); // 加密保存
const loaded = store.load(); // 加载
const session = store.loadSession(id); // 按会话加载
store.append(newMappings); // 追加
store.cleanup(86_400_000); // 清理过期映射
store.clearSession(sessionId); // 清理指定会话
```

### 自定义规则函数

```typescript
import {
  loadCustomRules,
  processCustomRulesConfig,
  validateUserRule,
  validateRegexSafety,
  registerNamedValidator,
  getNamedValidators,
} from "./privacy/index.js";

// 从文件加载
const result = loadCustomRules("./my-rules.json5");
// result.rules    → 合并后的规则数组
// result.errors   → 验证错误列表
// result.warnings → 警告信息

// 从对象处理
const result = processCustomRulesConfig({
  extends: "basic",
  disable: ["email"],
  rules: [{ type: "custom", description: "...", riskLevel: "low", pattern: "..." }],
});

// 验证单条规则
const errors = validateUserRule(rule, 0);

// 验证正则安全性
const error = validateRegexSafety("(a+)+"); // → "contains nested quantifiers..."

// 查看已注册的验证器
const names = getNamedValidators(); // → ["bare_password", "high_entropy"]
```

### 流包装（集成用）

```typescript
import {
  createPrivacyFilterContext,
  filterText,
  restoreText,
  filterPrompt,
  restoreResponse,
  wrapStreamFnPrivacyFilter,
} from "./privacy/index.js";

// 创建会话级上下文
const ctx = createPrivacyFilterContext("session-123", { rules: "./my-rules.json5" });

// 过滤单段文本
const filtered = filterText("my password=Secret123!", ctx);

// 还原
const restored = restoreText(filtered, ctx);

// 包装 LLM 调用流
const wrappedStreamFn = wrapStreamFnPrivacyFilter(originalStreamFn, ctx);
```
