// 量词读取结果类型
type QuantifierRead = {
  consumed: number;  // 消费的字符数
  minRepeat: number;  // 最小重复次数
  maxRepeat: number | null;  // 最大重复次数，null 表示无限制
};

// 令牌状态类型
type TokenState = {
  containsRepetition: boolean;  // 是否包含重复
  hasAmbiguousAlternation: boolean;  // 是否有歧义的分支
  minLength: number;  // 最小长度
  maxLength: number;  // 最大长度
};

// 解析框架类型
type ParseFrame = {
  lastToken: TokenState | null;  // 上一个令牌
  containsRepetition: boolean;  // 是否包含重复
  hasAlternation: boolean;  // 是否有分支
  branchMinLength: number;  // 当前分支最小长度
  branchMaxLength: number;  // 当前分支最大长度
  altMinLength: number | null;  // 所有分支最小长度
  altMaxLength: number | null;  // 所有分支最大长度
};

// 模式令牌类型
type PatternToken =
  | { kind: "simple-token" }  // 简单令牌
  | { kind: "group-open" }  // 组开始
  | { kind: "group-close" }  // 组结束
  | { kind: "alternation" }  // 分支
  | { kind: "quantifier"; quantifier: QuantifierRead };  // 量词

// 安全正则表达式缓存最大条目数
const SAFE_REGEX_CACHE_MAX = 256;
// 安全正则表达式测试窗口大小
const SAFE_REGEX_TEST_WINDOW = 2048;

// 安全正则表达式拒绝原因
export type SafeRegexRejectReason = "empty" | "unsafe-nested-repetition" | "invalid-regex";

// 安全正则表达式编译结果类型
export type SafeRegexCompileResult =
  | {
      regex: RegExp;  // 编译后的正则表达式
      source: string;  // 源字符串
      flags: string;  // 标志
      reason: null;  // 成功，无原因
    }
  | {
      regex: null;  // 编译失败
      source: string;  // 源字符串
      flags: string;  // 标志
      reason: SafeRegexRejectReason;  // 失败原因
    };

// 安全正则表达式缓存
const safeRegexCache = new Map<string, SafeRegexCompileResult>();

// 创建解析框架
function createParseFrame(): ParseFrame {
  return {
    lastToken: null,
    containsRepetition: false,
    hasAlternation: false,
    branchMinLength: 0,
    branchMaxLength: 0,
    altMinLength: null,
    altMaxLength: null,
  };
}

// 安全地相加两个长度值
function addLength(left: number, right: number): number {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return Number.POSITIVE_INFINITY;
  }
  return left + right;
}

// 安全地乘以长度值
function multiplyLength(length: number, factor: number): number {
  if (!Number.isFinite(length)) {
    return factor === 0 ? 0 : Number.POSITIVE_INFINITY;
  }
  return length * factor;
}

// 记录分支的替代值
function recordAlternative(frame: ParseFrame): void {
  if (frame.altMinLength === null || frame.altMaxLength === null) {
    // 第一个分支
    frame.altMinLength = frame.branchMinLength;
    frame.altMaxLength = frame.branchMaxLength;
    return;
  }
  // 更新最小和最大值
  frame.altMinLength = Math.min(frame.altMinLength, frame.branchMinLength);
  frame.altMaxLength = Math.max(frame.altMaxLength, frame.branchMaxLength);
}

// 读取量词
function readQuantifier(source: string, index: number): QuantifierRead | null {
  const ch = source[index];
  // 检查是否有非贪婪标志
  const consumed = source[index + 1] === "?" ? 2 : 1;
  if (ch === "*") {
    return { consumed, minRepeat: 0, maxRepeat: null };
  }
  if (ch === "+") {
    return { consumed, minRepeat: 1, maxRepeat: null };
  }
  if (ch === "?") {
    return { consumed, minRepeat: 0, maxRepeat: 1 };
  }
  // 不是量词字符
  if (ch !== "{") {
    return null;
  }

  // 解析 {n} 或 {n,} 或 {n,m}
  let i = index + 1;
  // 读取最小值
  while (i < source.length && /\d/.test(source[i])) {
    i += 1;
  }
  if (i === index + 1) {
    return null;  // 没有数字
  }

  const minRepeat = Number.parseInt(source.slice(index + 1, i), 10);
  let maxRepeat: number | null = minRepeat;
  // 检查逗号
  if (source[i] === ",") {
    i += 1;
    const maxStart = i;
    // 读取最大值
    while (i < source.length && /\d/.test(source[i])) {
      i += 1;
    }
    maxRepeat = i === maxStart ? null : Number.parseInt(source.slice(maxStart, i), 10);
  }

  // 必须以 } 结尾
  if (source[i] !== "}") {
    return null;
  }
  i += 1;
  // 检查非贪婪标志
  if (source[i] === "?") {
    i += 1;
  }
  // 最大值不能小于最小值
  if (maxRepeat !== null && maxRepeat < minRepeat) {
    return null;
  }

  return { consumed: i - index, minRepeat, maxRepeat };
}

// 将模式字符串标记化
function tokenizePattern(source: string): PatternToken[] {
  const tokens: PatternToken[] = [];
  let inCharClass = false;  // 是否在字符类中

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    // 在字符类中
    if (inCharClass) {
      if (ch === "\\") {
        i += 1;  // 跳过转义字符
        continue;
      }
      if (ch === "]") {
        inCharClass = false;
      }
      continue;
    }

    // 转义字符
    if (ch === "\\") {
      i += 1;
      tokens.push({ kind: "simple-token" });
      continue;
    }

    // 字符类开始
    if (ch === "[") {
      inCharClass = true;
      tokens.push({ kind: "simple-token" });
      continue;
    }

    // 组开始
    if (ch === "(") {
      tokens.push({ kind: "group-open" });
      continue;
    }

    // 组结束
    if (ch === ")") {
      tokens.push({ kind: "group-close" });
      continue;
    }

    // 分支
    if (ch === "|") {
      tokens.push({ kind: "alternation" });
      continue;
    }

    // 量词
    const quantifier = readQuantifier(source, i);
    if (quantifier) {
      tokens.push({ kind: "quantifier", quantifier });
      i += quantifier.consumed - 1;
      continue;
    }

    // 普通字符
    tokens.push({ kind: "simple-token" });
  }

  return tokens;
}

// 分析令牌是否有嵌套重复
function analyzeTokensForNestedRepetition(tokens: PatternToken[]): boolean {
  const frames: ParseFrame[] = [createParseFrame()];

  // 发出令牌
  const emitToken = (token: TokenState) => {
    const frame = frames[frames.length - 1];
    frame.lastToken = token;
    if (token.containsRepetition) {
      frame.containsRepetition = true;
    }
    frame.branchMinLength = addLength(frame.branchMinLength, token.minLength);
    frame.branchMaxLength = addLength(frame.branchMaxLength, token.maxLength);
  };

  // 发出简单令牌
  const emitSimpleToken = () => {
    emitToken({
      containsRepetition: false,
      hasAmbiguousAlternation: false,
      minLength: 1,
      maxLength: 1,
    });
  };

  for (const token of tokens) {
    if (token.kind === "simple-token") {
      emitSimpleToken();
      continue;
    }

    if (token.kind === "group-open") {
      frames.push(createParseFrame());
      continue;
    }

    if (token.kind === "group-close") {
      if (frames.length > 1) {
        const frame = frames.pop() as ParseFrame;
        if (frame.hasAlternation) {
          recordAlternative(frame);
        }
        // 计算组的最小和最大长度
        const groupMinLength = frame.hasAlternation
          ? (frame.altMinLength ?? 0)
          : frame.branchMinLength;
        const groupMaxLength = frame.hasAlternation
          ? (frame.altMaxLength ?? 0)
          : frame.branchMaxLength;
        emitToken({
          containsRepetition: frame.containsRepetition,
          hasAmbiguousAlternation:
            frame.hasAlternation &&
            frame.altMinLength !== null &&
            frame.altMaxLength !== null &&
            frame.altMinLength !== frame.altMaxLength,
          minLength: groupMinLength,
          maxLength: groupMaxLength,
        });
      }
      continue;
    }

    if (token.kind === "alternation") {
      const frame = frames[frames.length - 1];
      frame.hasAlternation = true;
      recordAlternative(frame);
      // 重置分支长度
      frame.branchMinLength = 0;
      frame.branchMaxLength = 0;
      frame.lastToken = null;
      continue;
    }

    // 处理量词
    const frame = frames[frames.length - 1];
    const previousToken = frame.lastToken;
    if (!previousToken) {
      continue;
    }
    // 检查是否有嵌套重复
    if (previousToken.containsRepetition) {
      return true;
    }
    // 检查有歧义的分支加上无限量词
    if (previousToken.hasAmbiguousAlternation && token.quantifier.maxRepeat === null) {
      return true;
    }

    // 计算新的长度
    const previousMinLength = previousToken.minLength;
    const previousMaxLength = previousToken.maxLength;
    previousToken.minLength = multiplyLength(previousToken.minLength, token.quantifier.minRepeat);
    previousToken.maxLength =
      token.quantifier.maxRepeat === null
        ? Number.POSITIVE_INFINITY
        : multiplyLength(previousToken.maxLength, token.quantifier.maxRepeat);
    previousToken.containsRepetition = true;
    frame.containsRepetition = true;
    frame.branchMinLength = frame.branchMinLength - previousMinLength + previousToken.minLength;

    // 计算分支最大长度
    const branchMaxBase =
      Number.isFinite(frame.branchMaxLength) && Number.isFinite(previousMaxLength)
        ? frame.branchMaxLength - previousMaxLength
        : Number.POSITIVE_INFINITY;
    frame.branchMaxLength = addLength(branchMaxBase, previousToken.maxLength);
  }

  return false;
}

// 从正则表达式开头测试匹配
function testRegexFromStart(regex: RegExp, value: string): boolean {
  regex.lastIndex = 0;
  return regex.test(value);
}

// 使用有限输入测试正则表达式
export function testRegexWithBoundedInput(
  regex: RegExp,
  input: string,
  maxWindow = SAFE_REGEX_TEST_WINDOW,
): boolean {
  if (maxWindow <= 0) {
    return false;
  }
  if (input.length <= maxWindow) {
    return testRegexFromStart(regex, input);
  }
  // 测试头部
  const head = input.slice(0, maxWindow);
  if (testRegexFromStart(regex, head)) {
    return true;
  }
  // 测试尾部
  return testRegexFromStart(regex, input.slice(-maxWindow));
}

// 检查是否有嵌套重复
export function hasNestedRepetition(source: string): boolean {
  // 保守解析器：首先标记化，然后检查重复的令牌/组是否重复
  // 不追求完整的正则表达式 AST 支持；保持足够严格以进行配置安全检查
  return analyzeTokensForNestedRepetition(tokenizePattern(source));
}

// 详细编译安全正则表达式
export function compileSafeRegexDetailed(source: string, flags = ""): SafeRegexCompileResult {
  const trimmed = source.trim();
  // 检查空字符串
  if (!trimmed) {
    return { regex: null, source: trimmed, flags, reason: "empty" };
  }
  // 检查缓存
  const cacheKey = `${flags}::${trimmed}`;
  if (safeRegexCache.has(cacheKey)) {
    return (
      safeRegexCache.get(cacheKey) ?? {
        regex: null,
        source: trimmed,
        flags,
        reason: "invalid-regex",
      }
    );
  }

  let result: SafeRegexCompileResult;
  // 检查嵌套重复
  if (hasNestedRepetition(trimmed)) {
    result = { regex: null, source: trimmed, flags, reason: "unsafe-nested-repetition" };
  } else {
    try {
      result = { regex: new RegExp(trimmed, flags), source: trimmed, flags, reason: null };
    } catch {
      result = { regex: null, source: trimmed, flags, reason: "invalid-regex" };
    }
  }

  // 缓存结果
  safeRegexCache.set(cacheKey, result);
  // 保持缓存大小限制
  if (safeRegexCache.size > SAFE_REGEX_CACHE_MAX) {
    const oldestKey = safeRegexCache.keys().next().value;
    if (oldestKey) {
      safeRegexCache.delete(oldestKey);
    }
  }
  return result;
}

// 编译安全正则表达式（简单版本）
export function compileSafeRegex(source: string, flags = ""): RegExp | null {
  return compileSafeRegexDetailed(source, flags).regex;
}
