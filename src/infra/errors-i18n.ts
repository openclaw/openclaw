// 错误信息国际化 - 支持中英双语错误信息 / Error message i18n - supports Chinese and English error messages

/**
 * 错误信息接口 / Error message interface
 */
export interface ErrorMessage {
  /** 错误代码 / Error code */
  code: string;
  /** 英文错误信息 / English error message */
  en: string;
  /** 中文错误信息 / Chinese error message */
  "zh-CN": string;
}

/**
 * 核心错误信息映射表 / Core error message mapping table
 * 包含系统中最常见的错误信息 / Contains the most common error messages in the system
 */
export const ERROR_MESSAGES: Record<string, ErrorMessage> = {
  // ===== 通用错误 / General errors =====
  UNKNOWN_ERROR: {
    code: "UNKNOWN_ERROR",
    en: "An unknown error occurred",
    "zh-CN": "发生未知错误",
  },
  INVALID_ARGUMENT: {
    code: "INVALID_ARGUMENT",
    en: "Invalid argument provided",
    "zh-CN": "提供了无效的参数",
  },
  MISSING_REQUIRED_ARG: {
    code: "MISSING_REQUIRED_ARG",
    en: "Missing required argument",
    "zh-CN": "缺少必需的参数",
  },

  // ===== 网关错误 / Gateway errors =====
  GATEWAY_START_FAILED: {
    code: "GATEWAY_START_FAILED",
    en: "Failed to start gateway",
    "zh-CN": "启动网关失败",
  },
  GATEWAY_STOP_FAILED: {
    code: "GATEWAY_STOP_FAILED",
    en: "Failed to stop gateway",
    "zh-CN": "停止网关失败",
  },
  GATEWAY_NOT_RUNNING: {
    code: "GATEWAY_NOT_RUNNING",
    en: "Gateway is not running",
    "zh-CN": "网关未运行",
  },
  GATEWAY_ALREADY_RUNNING: {
    code: "GATEWAY_ALREADY_RUNNING",
    en: "Gateway is already running",
    "zh-CN": "网关已在运行中",
  },
  GATEWAY_CONNECTION_FAILED: {
    code: "GATEWAY_CONNECTION_FAILED",
    en: "Failed to connect to gateway",
    "zh-CN": "连接网关失败",
  },

  // ===== 认证错误 / Authentication errors =====
  AUTH_TOKEN_MISSING: {
    code: "AUTH_TOKEN_MISSING",
    en: "Authentication token is missing",
    "zh-CN": "缺少认证令牌",
  },
  AUTH_TOKEN_INVALID: {
    code: "AUTH_TOKEN_INVALID",
    en: "Authentication token is invalid",
    "zh-CN": "认证令牌无效",
  },
  AUTH_TOKEN_EXPIRED: {
    code: "AUTH_TOKEN_EXPIRED",
    en: "Authentication token has expired",
    "zh-CN": "认证令牌已过期",
  },
  AUTH_PASSWORD_MISSING: {
    code: "AUTH_PASSWORD_MISSING",
    en: "Authentication password is missing",
    "zh-CN": "缺少认证密码",
  },
  AUTH_PASSWORD_INVALID: {
    code: "AUTH_PASSWORD_INVALID",
    en: "Authentication password is invalid",
    "zh-CN": "认证密码无效",
  },
  AUTH_FAILED: {
    code: "AUTH_FAILED",
    en: "Authentication failed",
    "zh-CN": "认证失败",
  },
  AUTH_UNAUTHORIZED: {
    code: "AUTH_UNAUTHORIZED",
    en: "Unauthorized access",
    "zh-CN": "未授权访问",
  },

  // ===== 配置错误 / Configuration errors =====
  CONFIG_NOT_FOUND: {
    code: "CONFIG_NOT_FOUND",
    en: "Configuration file not found",
    "zh-CN": "未找到配置文件",
  },
  CONFIG_PARSE_ERROR: {
    code: "CONFIG_PARSE_ERROR",
    en: "Failed to parse configuration file",
    "zh-CN": "解析配置文件失败",
  },
  CONFIG_INVALID_VALUE: {
    code: "CONFIG_INVALID_VALUE",
    en: "Invalid configuration value",
    "zh-CN": "配置值无效",
  },
  CONFIG_MISSING_REQUIRED: {
    code: "CONFIG_MISSING_REQUIRED",
    en: "Missing required configuration",
    "zh-CN": "缺少必需的配置",
  },

  // ===== 文件系统错误 / File system errors =====
  FILE_NOT_FOUND: {
    code: "FILE_NOT_FOUND",
    en: "File not found",
    "zh-CN": "文件未找到",
  },
  FILE_READ_ERROR: {
    code: "FILE_READ_ERROR",
    en: "Failed to read file",
    "zh-CN": "读取文件失败",
  },
  FILE_WRITE_ERROR: {
    code: "FILE_WRITE_ERROR",
    en: "Failed to write file",
    "zh-CN": "写入文件失败",
  },
  FILE_PERMISSION_DENIED: {
    code: "FILE_PERMISSION_DENIED",
    en: "Permission denied",
    "zh-CN": "权限被拒绝",
  },

  // ===== 网络错误 / Network errors =====
  NETWORK_TIMEOUT: {
    code: "NETWORK_TIMEOUT",
    en: "Network request timed out",
    "zh-CN": "网络请求超时",
  },
  NETWORK_CONNECTION_FAILED: {
    code: "NETWORK_CONNECTION_FAILED",
    en: "Network connection failed",
    "zh-CN": "网络连接失败",
  },
  NETWORK_DNS_ERROR: {
    code: "NETWORK_DNS_ERROR",
    en: "DNS resolution failed",
    "zh-CN": "DNS 解析失败",
  },

  // ===== 会话错误 / Session errors =====
  SESSION_NOT_FOUND: {
    code: "SESSION_NOT_FOUND",
    en: "Session not found",
    "zh-CN": "会话未找到",
  },
  SESSION_EXPIRED: {
    code: "SESSION_EXPIRED",
    en: "Session has expired",
    "zh-CN": "会话已过期",
  },
  SESSION_LIMIT_REACHED: {
    code: "SESSION_LIMIT_REACHED",
    en: "Maximum number of sessions reached",
    "zh-CN": "已达到最大会话数",
  },

  // ===== 模型错误 / Model errors =====
  MODEL_NOT_FOUND: {
    code: "MODEL_NOT_FOUND",
    en: "Model not found",
    "zh-CN": "模型未找到",
  },
  MODEL_LOAD_FAILED: {
    code: "MODEL_LOAD_FAILED",
    en: "Failed to load model",
    "zh-CN": "加载模型失败",
  },
  MODEL_API_ERROR: {
    code: "MODEL_API_ERROR",
    en: "Model API error",
    "zh-CN": "模型 API 错误",
  },
};

/**
 * 格式化错误信息 / Format error message
 * 根据语言环境返回相应的错误信息 / Returns error message based on locale
 *
 * @param code - 错误代码 / Error code
 * @param locale - 语言环境（默认为 'en'）/ Locale (defaults to 'en')
 * @returns 格式化后的错误信息 / Formatted error message
 *
 * @example
 * formatError('AUTH_TOKEN_MISSING', 'zh-CN') // 返回 '缺少认证令牌'
 * formatError('AUTH_TOKEN_MISSING', 'en') // 返回 'Authentication token is missing'
 */
export function formatError(code: string, locale: string = "en"): string {
  const errorMessage = ERROR_MESSAGES[code];

  if (!errorMessage) {
    // 如果错误代码未找到，返回通用错误信息 / Return generic error if code not found
    const unknownError = ERROR_MESSAGES.UNKNOWN_ERROR;
    return locale === "zh-CN" ? unknownError["zh-CN"] : unknownError.en;
  }

  // 返回对应语言的错误信息 / Return error message in the corresponding language
  return locale === "zh-CN" ? errorMessage["zh-CN"] : errorMessage.en;
}

/**
 * 获取错误对象 / Get error object
 * 返回完整的错误信息对象 / Returns complete error message object
 *
 * @param code - 错误代码 / Error code
 * @returns 错误信息对象或 undefined / Error message object or undefined
 *
 * @example
 * getErrorObject('AUTH_TOKEN_MISSING')
 * // 返回 { code: 'AUTH_TOKEN_MISSING', en: '...', 'zh-CN': '...' }
 */
export function getErrorObject(code: string): ErrorMessage | undefined {
  return ERROR_MESSAGES[code];
}

/**
 * 创建带参数的错误信息 / Create error message with parameters
 * 支持在错误信息中插入动态参数 / Supports inserting dynamic parameters in error messages
 *
 * @param code - 错误代码 / Error code
 * @param params - 参数对象 / Parameters object
 * @param locale - 语言环境 / Locale
 * @returns 格式化后的错误信息 / Formatted error message
 *
 * @example
 * formatErrorWithParams('FILE_NOT_FOUND', { filename: 'config.json' }, 'zh-CN')
 * // 返回 '文件未找到: config.json'
 */
export function formatErrorWithParams(
  code: string,
  params: Record<string, string | number>,
  locale: string = "en",
): string {
  let message = formatError(code, locale);

  // 将参数附加到错误信息后 / Append parameters to error message
  const paramStrings = Object.entries(params)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");

  if (paramStrings) {
    const separator = locale === "zh-CN" ? "：" : ": ";
    message = `${message}${separator}${paramStrings}`;
  }

  return message;
}

/**
 * 检查错误代码是否存在 / Check if error code exists
 *
 * @param code - 错误代码 / Error code
 * @returns 是否存在 / Whether exists
 */
export function hasErrorCode(code: string): boolean {
  return code in ERROR_MESSAGES;
}

/**
 * 获取所有错误代码 / Get all error codes
 *
 * @returns 所有错误代码数组 / Array of all error codes
 */
export function getAllErrorCodes(): string[] {
  return Object.keys(ERROR_MESSAGES);
}
