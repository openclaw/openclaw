function normalizePath(pathname: string) {
  const trimmed = pathname.trim();
  if (!trimmed) {
    return "/";
  }
  if (trimmed === "/") {
    return trimmed;
  }
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

const path = normalizePath(window.location.pathname);

if (path === "/pilot/project") {
  void import("./pilot/project.ts");
} else if (path === "/pilot") {
  void import("./pilot/home.ts");
} else {
  void import("./styles.css");
  void import("./ui/app.ts");
}
