export const maskApiKey = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "missing";
  }
  if (trimmed.length <= 4) {
    return `${trimmed.slice(0, 1)}...`;
  }
  return `${trimmed.slice(0, 4)}...`;
};
