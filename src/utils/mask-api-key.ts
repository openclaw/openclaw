export const maskApiKey = (value: string): string => {
  if (!value.trim()) {
    return "missing";
  }
  return "****";
};
