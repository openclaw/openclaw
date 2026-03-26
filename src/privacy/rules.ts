/**
 * Privacy detection rules — merged from basic and extended config files.
 * Rules are TypeScript constants; no runtime JSON loading needed.
 */

import { loadCustomRules } from "./custom-rules.js";
import { validateBarePassword, validateHighEntropy } from "./detector.js";
import type { PrivacyRule } from "./types.js";

/** Basic rule set (high-impact rules only). */
export const BASIC_RULES: PrivacyRule[] = [
  {
    type: "email",
    description: "Email address",
    enabled: true,
    riskLevel: "medium",
    pattern: String.raw`\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`,
  },
  {
    type: "phone_cn",
    description: "China mainland phone number",
    enabled: true,
    riskLevel: "medium",
    pattern: String.raw`\b1[3-9]\d{9}\b`,
  },
  {
    type: "id_card_cn",
    description: "China ID card number",
    enabled: true,
    riskLevel: "high",
    pattern: String.raw`\b[1-9]\d{5}(18|19|20)\d{2}((0[1-9])|(1[0-2]))(([0-2][1-9])|10|20|30|31)\d{3}[0-9Xx]\b`,
  },
  {
    type: "credit_card",
    description: "Credit card number (major networks)",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b`,
  },
  {
    type: "bank_account_cn",
    description: "China bank account number (16-19 digits)",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\b[1-9]\d{15,18}\b`,
    context: {
      mustContain: ["银行", "账户", "账号", "卡号", "bank", "account", "card"],
    },
  },
  {
    type: "password_assignment",
    description: "Password assignment statement",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`(?i)(password|pwd|passwd|pass)\s*[:=]\s*['"]?[^\s'")\}]{6,}['"]?`,
  },
  {
    type: "env_password",
    description: "Environment variable password",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`(?i)(PASSWORD|PWD|PASSWD|SECRET|PASS)=[^\s&;)\}]{6,}`,
  },
  {
    type: "github_token",
    description: "GitHub access token",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b`,
  },
  {
    type: "openai_api_key",
    description: "OpenAI API key (sk-*, sk-proj-*)",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\bsk-(?:proj-)?[A-Za-z0-9_\-]{8,}\b`,
  },
  {
    type: "slack_token",
    description: "Slack token",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\b(xoxb|xoxp|xoxa|xoxr|xoxs)-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{24,}\b`,
  },
  {
    type: "google_api_key",
    description: "Google API key",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\bAIza[0-9A-Za-z_-]{35}\b`,
  },
  {
    type: "stripe_api_key",
    description: "Stripe API key",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\b(sk|pk)_(live|test)_[0-9A-Za-z]{24,}\b`,
  },
  {
    type: "aws_access_key",
    description: "AWS access key ID",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\b(AKIA|A3T|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[0-9A-Z]{16}\b`,
  },
  {
    type: "aws_secret_key",
    description: "AWS secret access key",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`(?i)aws(.{0,20})?(?:secret|access)(.{0,20})?['"][0-9a-zA-Z/+=]{40}['"]`,
  },
  {
    type: "alibaba_access_key",
    description: "Alibaba Cloud AccessKey",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\b(LTAI|LTAk)[A-Za-z0-9]{12,30}\b`,
  },
  {
    type: "tencent_secret_id",
    description: "Tencent Cloud SecretId",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\bAKID[A-Za-z0-9]{32,}\b`,
  },
  {
    type: "jwt_token",
    description: "JWT token",
    enabled: true,
    riskLevel: "high",
    pattern: String.raw`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`,
  },
  {
    type: "generic_api_key",
    description: "Generic API key pattern",
    enabled: true,
    riskLevel: "high",
    pattern: String.raw`(?i)(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret)\s*[:=]\s*['"]?[A-Za-z0-9_\-\.]{32,}['"]?`,
  },
  {
    type: "bearer_token",
    description: "Bearer token",
    enabled: true,
    riskLevel: "high",
    pattern: String.raw`(?i)bearer\s+[A-Za-z0-9_\-\.]{20,}`,
  },
  {
    type: "ssh_private_key",
    description: "SSH private key",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`-----BEGIN (RSA|OPENSSH|DSA|EC|PGP) PRIVATE KEY-----[\s\S]+?-----END \1 PRIVATE KEY-----`,
  },
  {
    type: "database_url_mysql",
    description: "MySQL connection URL",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`mysql://[^\s:]+:[^\s@]+@[^\s/]+/\S+`,
  },
  {
    type: "database_url_postgresql",
    description: "PostgreSQL connection URL",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`postgres(ql)?://[^\s:]+:[^\s@]+@[^\s/]+/\S+`,
  },
  {
    type: "database_url_mongodb",
    description: "MongoDB connection URL",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`mongodb(\+srv)?://[^\s:]+:[^\s@]+@[^\s/]+/\S+`,
  },
  {
    type: "redis_url",
    description: "Redis connection URL",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`redis://[^\s:]*:[^\s@]+@[^\s/]+(:\d+)?/?`,
  },
  {
    type: "url_with_credentials",
    description: "URL with embedded credentials",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\b(https?|ftp)://[^\s:]+:[^\s@]+@[^\s]+\b`,
  },
  {
    type: "basic_auth",
    description: "HTTP Basic authentication",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`(?i)authorization:\s*basic\s+[A-Za-z0-9+/=]{20,}`,
  },
  {
    type: "social_security_number_us",
    description: "US Social Security Number",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\b\d{3}-\d{2}-\d{4}\b`,
  },
  // ─── Bare password & high-entropy detectors ───
  {
    type: "bare_password",
    description: "Bare password (complex string with 3+ character classes)",
    enabled: true,
    riskLevel: "high",
    // Match standalone non-whitespace tokens of 8-64 characters.
    // The validate function filters for actual password-like complexity.
    pattern: String.raw`(?:^|(?<=\s))\S{8,64}(?=$|\s)`,
    validate: validateBarePassword,
  },
  {
    type: "high_entropy_string",
    description: "High-entropy string (likely a key or token)",
    enabled: true,
    riskLevel: "high",
    // Match long alphanumeric+symbol sequences (base64, hex, random tokens).
    pattern: String.raw`[A-Za-z0-9+/=_\-]{16,}`,
    validate: validateHighEntropy,
  },
];

/** Extended rule set — includes all basic rules plus additional coverage. */
export const EXTENDED_RULES: PrivacyRule[] = [
  ...BASIC_RULES,
  // Additional phone formats
  {
    type: "phone_hk",
    description: "Hong Kong phone number",
    enabled: true,
    riskLevel: "medium",
    pattern: String.raw`\b[569]\d{7}\b`,
    context: { mustContain: ["香港", "HK", "Hong Kong", "电话", "手机"] },
  },
  {
    type: "phone_tw",
    description: "Taiwan phone number",
    enabled: true,
    riskLevel: "medium",
    pattern: String.raw`\b09\d{8}\b`,
  },
  {
    type: "phone_us",
    description: "US phone number",
    enabled: true,
    riskLevel: "medium",
    pattern: String.raw`\b(?:\+?1[-.\s]?)?\(?([2-9][0-8][0-9])\)?[-.\s]?([2-9][0-9]{2})[-.\s]?([0-9]{4})\b`,
  },
  // Additional ID documents
  {
    type: "id_card_hk",
    description: "Hong Kong ID card",
    enabled: true,
    riskLevel: "high",
    pattern: String.raw`\b[A-Z]{1,2}\d{6}\([0-9A]\)`,
  },
  {
    type: "passport_cn",
    description: "China passport number",
    enabled: true,
    riskLevel: "high",
    pattern: String.raw`\b[EGP]\d{8}\b`,
    context: { mustContain: ["护照", "passport"] },
  },
  {
    type: "passport_number",
    description: "Passport number (multi-country)",
    enabled: true,
    riskLevel: "high",
    pattern: String.raw`(?i)(护照|passport)[号\s#:：]+[A-Z]{1,2}[0-9]{6,9}`,
  },
  // Credit card variants
  {
    type: "credit_card_unionpay",
    description: "UnionPay card",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\b62[0-9]{14,17}\b`,
  },
  {
    type: "iban",
    description: "International Bank Account Number",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\b[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}([A-Z0-9]?){0,16}\b`,
  },
  // Payment accounts
  {
    type: "alipay_account",
    description: "Alipay account",
    enabled: true,
    riskLevel: "high",
    pattern: String.raw`\b1[3-9]\d{9}\b|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`,
    context: { mustContain: ["支付宝", "Alipay"] },
  },
  {
    type: "wechat_id",
    description: "WeChat ID",
    enabled: true,
    riskLevel: "medium",
    pattern: String.raw`(?i)(微信|wechat|wx)[号\s#:：]+[a-zA-Z][a-zA-Z0-9_-]{5,19}`,
  },
  // Additional API tokens
  {
    type: "anthropic_api_key",
    description: "Anthropic API key",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\bsk-ant-[A-Za-z0-9_\-]{30,}\b`,
  },
  {
    type: "gitlab_token",
    description: "GitLab access token",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\bglpat-[A-Za-z0-9_\-]{20,}\b`,
  },
  {
    type: "discord_token",
    description: "Discord bot token",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\b[MN][A-Za-z0-9]{23,25}\.[A-Za-z0-9]{6}\.[A-Za-z0-9_\-]{27,}\b`,
  },
  {
    type: "npm_token",
    description: "NPM access token",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\bnpm_[A-Za-z0-9]{36}\b`,
  },
  {
    type: "pypi_token",
    description: "PyPI API token",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\bpypi-[A-Za-z0-9_\-]{50,}\b`,
  },
  {
    type: "sendgrid_api_key",
    description: "SendGrid API key",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\bSG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}\b`,
  },
  {
    type: "twilio_api_key",
    description: "Twilio API key",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\bSK[a-z0-9]{32}\b`,
  },
  {
    type: "shopify_token",
    description: "Shopify access token",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\bshpat_[a-fA-F0-9]{32}\b`,
  },
  {
    type: "square_token",
    description: "Square access token",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\bsq0atp-[0-9A-Za-z_\-]{22,}\b`,
  },
  {
    type: "newrelic_key",
    description: "New Relic key",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\bNRAK-[A-Z0-9]{27}\b`,
  },
  {
    type: "mailchimp_api_key",
    description: "Mailchimp API key",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\b[a-f0-9]{32}-us[0-9]{1,2}\b`,
  },
  {
    type: "sentry_dsn",
    description: "Sentry DSN",
    enabled: true,
    riskLevel: "high",
    pattern: String.raw`https://[a-f0-9]{32}@[a-z0-9\.]+\.ingest\.sentry\.io/\d+`,
  },
  // Cloud provider keys
  {
    type: "azure_storage_key",
    description: "Azure Storage key",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`(?i)DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[A-Za-z0-9+/=]{88};EndpointSuffix=core\.windows\.net`,
  },
  {
    type: "azure_client_secret",
    description: "Azure Client Secret",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`(?i)(client_secret|azure_secret)\s*[:=]\s*['"]?[A-Za-z0-9_\-\.~]{34,40}['"]?`,
  },
  // Database URLs
  {
    type: "jdbc_connection",
    description: "JDBC connection string",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`jdbc:(mysql|postgresql|oracle|sqlserver|mariadb)://[^\s]+`,
  },
  {
    type: "connection_string_dotnet",
    description: ".NET connection string",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`(?i)(Server|Data Source)=[^;]+;.*(Password|PWD)=[^;]+`,
  },
  {
    type: "elasticsearch_url",
    description: "Elasticsearch URL with credentials",
    enabled: true,
    riskLevel: "high",
    pattern: String.raw`https?://[^\s:]+:[^\s@]+@[^\s/]+:9200`,
  },
  {
    type: "rabbitmq_url",
    description: "RabbitMQ URL",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`amqps?://[^\s:]+:[^\s@]+@[^\s/]+`,
  },
  // Crypto
  {
    type: "private_key_hex",
    description: "Hex private key (64 chars)",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`\b(0x)?[a-fA-F0-9]{64}\b`,
    context: { mustContain: ["private", "key", "secret", "私钥", "密钥"] },
  },
  {
    type: "ethereum_address",
    description: "Ethereum address",
    enabled: true,
    riskLevel: "medium",
    pattern: String.raw`\b0x[a-fA-F0-9]{40}\b`,
    context: { mustContain: ["ethereum", "eth", "以太坊", "钱包", "wallet"] },
  },
  // Network
  {
    type: "ipv4_private",
    description: "Private IPv4 address",
    enabled: true,
    riskLevel: "low",
    pattern: String.raw`\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b`,
  },
  // Auth tokens
  {
    type: "oauth_secret",
    description: "OAuth Client Secret",
    enabled: true,
    riskLevel: "critical",
    pattern: String.raw`(?i)(client[_-]?secret|oauth[_-]?secret|consumer[_-]?secret)\s*[:=]\s*['"]?[A-Za-z0-9_\-\.]{20,}['"]?`,
  },
  {
    type: "oauth_refresh_token",
    description: "OAuth Refresh Token",
    enabled: true,
    riskLevel: "high",
    pattern: String.raw`(?i)refresh[_-]?token\s*[:=]\s*['"]?[A-Za-z0-9_\-\.]{20,}['"]?`,
  },
  {
    type: "session_token",
    description: "Session token",
    enabled: true,
    riskLevel: "high",
    pattern: String.raw`(?i)(session[_-]?id|sessionid|sess|phpsessid)\s*[:=]\s*['"]?[A-Za-z0-9_\-\.]{32,}['"]?`,
  },
  // PII
  {
    type: "salary_amount",
    description: "Salary amount",
    enabled: true,
    riskLevel: "medium",
    pattern: String.raw`(年薪|月薪|工资|薪水|salary|compensation)\s*[:：]?\s*[¥$￥€£]?\s*\d{4,}`,
  },
];

/** Resolve rules by preset name or custom file path. */
export function resolveRules(preset: string): PrivacyRule[] {
  if (preset === "none") {
    return [];
  }
  if (preset === "basic") {
    return BASIC_RULES;
  }
  if (preset === "extended") {
    return EXTENDED_RULES;
  }

  // Treat any other string as a file path to a custom rules JSON5 config.
  const result = loadCustomRules(preset);
  if (result.errors.length > 0) {
    const errorMessages = result.errors
      .map((e) => `  Rule[${e.ruleIndex}] (${e.type}).${e.field}: ${e.message}`)
      .join("\n");
    console.warn(
      `[privacy] Custom rules file "${preset}" has validation errors:\n${errorMessages}\n` +
        `  ${result.errors.length} invalid rule(s) were skipped.`,
    );
  }
  if (result.warnings.length > 0) {
    for (const w of result.warnings) {
      console.warn(`[privacy] ${w}`);
    }
  }
  return result.rules;
}
