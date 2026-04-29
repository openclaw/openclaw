// 掩码 API 密钥函数
// 将敏感的 API 密钥进行掩码处理，只显示部分字符
export const maskApiKey = (value: string): string => {
  const trimmed = value.trim();
  // 空值返回 "missing"
  if (!trimmed) {
    return "missing";
  }
  // 长度小于等于 6，只显示首尾各一个字符
  if (trimmed.length <= 6) {
    return `${trimmed.slice(0, 1)}...${trimmed.slice(-1)}`;
  }
  // 长度小于等于 16，显示首尾各两个字符
  if (trimmed.length <= 16) {
    return `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`;
  }
  // 长度大于 16，显示首尾各 8 个字符
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-8)}`;
};
