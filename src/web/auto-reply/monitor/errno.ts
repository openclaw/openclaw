export function isErrno(err: unknown, code: string): boolean {
  return (
    !!err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === code
  );
}
