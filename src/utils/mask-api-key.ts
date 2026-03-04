export const maskApiKey = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "missing";
  }
  return "****";
};
