export function validateIPv4AddressInput(value: string | undefined): string | undefined {
  if (!value) {
    return "IP address is required for custom bind mode";
  }
  const trimmed = value.trim();
  const parts = trimmed.split(".");
  if (parts.length !== 4) {
    return "Invalid IPv4 address (e.g., 192.168.1.100)";
  }
  if (
    parts.every((part) => {
      const n = parseInt(part, 10);
      return !Number.isNaN(n) && n >= 0 && n <= 255 && part === String(n);
    })
  ) {
    return undefined;
  }
  return "Invalid IPv4 address (each octet must be 0-255)";
}
