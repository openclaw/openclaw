export const FEISHU_DOMAIN = "https://open.feishu.cn";
export const LARK_DOMAIN = "https://open.larksuite.com";

export type FeishuDomainInput = string | null | undefined;

export function normalizeFeishuDomain(value?: FeishuDomainInput): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  if (lower === "feishu" || lower === "cn" || lower === "china") {
    return FEISHU_DOMAIN;
  }
  if (lower === "lark" || lower === "global" || lower === "intl" || lower === "international") {
    return LARK_DOMAIN;
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const withoutTrailing = withScheme.replace(/\/+$/, "");
  return withoutTrailing.replace(/\/open-apis$/i, "");
}

export function resolveFeishuDomain(value?: FeishuDomainInput): string {
  return normalizeFeishuDomain(value) ?? FEISHU_DOMAIN;
}

export function resolveFeishuApiBase(value?: FeishuDomainInput): string {
  const base = resolveFeishuDomain(value);
  return `${base.replace(/\/+$/, "")}/open-apis`;
}
