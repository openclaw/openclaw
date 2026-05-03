import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { analyzeShellCommand, type ExecCommandSegment } from "./exec-approvals-analysis.js";
import { SsrFBlockedError, isBlockedHostnameOrIp, type SsrFPolicy } from "./net/ssrf.js";

/**
 * Network tools that commonly make HTTP(S) requests and should be SSRF-filtered.
 * These tools have URL arguments that can be extracted and validated.
 */
const NETWORK_TOOLS = new Set(["curl", "wget", "httpx", "aria2c", "http", "httpry", "curlie"]);

/**
 * Options that take a value and should be skipped when looking for URL arguments.
 * The value after these options is not a URL.
 */
const CURL_OPTIONS_WITH_VALUE = new Set([
  "-o",
  "-O",
  "-w",
  "-H",
  "-A",
  "-e",
  "-b",
  "-c",
  "-d",
  "--data",
  "--data-binary",
  "--data-raw",
  "--data-urlencode",
  "--header",
  "--user-agent",
  "--referer",
  "--cookie",
  "--cookie-jar",
  "--output",
  "--write-out",
  "--upload-file",
  "--form",
  "--form-string",
  "--mail-from",
  "--mail-to",
  "--mail-subject",
  "--mail-auth",
  "--proxy-user",
  "--proxy",
  "--preproxy",
  "--resolve",
  "--connect-to",
  "--dns-servers",
  "--interface",
  "--krb",
  "--libcurl",
  "--trace",
  "--trace-ascii",
  "--trace-time",
  "--log-file",
  "--netrc-file",
  "--cacert",
  "--capath",
  "--cert",
  "--cert-status",
  "--ciphers",
  "--compressed",
  "--egd-file",
  "--engine",
  "--hostpubmd5",
  "--hostpubsha256",
  "--key",
  "--key-type",
  "--pass",
  "--pinnedpubkey",
  "--proxy-cacert",
  "--proxy-capath",
  "--proxy-cert",
  "--proxy-cert-type",
  "--proxy-ciphers",
  "--proxy-key",
  "--proxy-key-type",
  "--proxy-pass",
  "--proxy-pinnedpubkey",
  "--proxy-service-name",
  "--proxy-tls13-ciphers",
  "--proxy-tlsauthtype",
  "--proxy-tlspassword",
  "--proxy-tlsuser",
  "--random-file",
  "--service-name",
  "--tls13-ciphers",
  "--tlsauthtype",
  "--tlspassword",
  "--tlsuser",
  "-u",
  "--user",
  "-T",
  "--upload-file",
  "-F",
  "--form",
  "-E",
  "--cert",
  "-K",
  "--config",
  "-C",
  "--continue-at",
  "-P",
  "--ftp-port",
  "--limit-rate",
  "--max-filesize",
  "--max-redirs",
  "--max-time",
  "--speed-limit",
  "--speed-time",
  "--time-cond",
  "--timeout",
  "--connect-timeout",
  "--expect100-timeout",
  "--happy-eyeballs-timeout-ms",
  "--doh-url",
  "--parallel-max",
  "--rate",
  "--retry",
  "--retry-delay",
  "--retry-max-time",
  "--retry-connrefused",
  "--retry-all-errors",
  "-S",
  "--show-error",
  "-v",
  "--verbose",
  "-V",
  "--version",
  "-h",
  "--help",
  "-M",
  "--manual",
  "-f",
  "--fail",
  "--fail-early",
  "--fail-with-body",
  "-Z",
  "--parallel",
  "-z",
  "--time-cond",
  "-Y",
  "--speed-limit",
  "-y",
  "--speed-time",
  "-g",
  "--globoff",
  "-G",
  "--get",
  "-q",
  "--disable",
  "-r",
  "--range",
  "-n",
  "--netrc",
  "--netrc-optional",
  "-N",
  "--no-buffer",
  "-p",
  "--proxy-tunnel",
  "-R",
  "--remote-time",
  "-Q",
  "--quote",
  "-#",
  "--progress-bar",
  "--proto",
  "--proto-default",
  "--proto-redir",
  "--alt-svc",
  "--hsts",
  "-6",
  "--ipv6",
  "--dns-interface",
  "--dns-ipv4-addr",
  "--dns-ipv6-addr",
]);

/**
 * Options that are standalone (don't take a value).
 */
const CURL_STANDALONE_OPTIONS = new Set([
  "-s",
  "--silent",
  "-S",
  "--show-error",
  "-v",
  "--verbose",
  "-V",
  "--version",
  "-h",
  "--help",
  "-L",
  "--location",
  "--location-trusted",
  "-f",
  "--fail",
  "--fail-early",
  "--fail-with-body",
  "-Z",
  "--parallel",
  "-g",
  "--globoff",
  "-G",
  "--get",
  "-q",
  "--disable",
  "-I",
  "--head",
  "-i",
  "--include",
  "-k",
  "--insecure",
  "-n",
  "--netrc",
  "--netrc-optional",
  "-N",
  "--no-buffer",
  "-p",
  "--proxy-tunnel",
  "-R",
  "--remote-time",
  "-#",
  "--progress-bar",
  "-4",
  "--ipv4",
  "-6",
  "--ipv6",
  "--compressed-ssh",
  "--create-dirs",
  "--create-file-mode",
  "--crlf",
  "--digest",
  "--disable-epsv",
  "--disable-eprt",
  "--disallow-username-in-url",
  "--epsv",
  "--eprt",
  "--environment",
  "--ftp-create-dirs",
  "--ftp-method",
  "--ftp-pasv",
  "--ftp-skip-pasv-ip",
  "--ftp-ssl",
  "--ftp-ssl-ccc",
  "--ftp-ssl-ccc-mode",
  "--ftp-ssl-control",
  "--ftp-ssl-reqd",
  "--ftp-use-pret",
  "--ftp-port",
  "--ftp-account",
  "--ftp-alternative-to-user",
  "--head",
  "--http1.0",
  "--http1.1",
  "--http2",
  "--http2-prior-knowledge",
  "--http3",
  "--http3-only",
  "--ignore-content-length",
  "--keepalive-time",
  "--krb4",
  "--libcurl",
  "--list-only",
  "--local-port",
  "--manual",
  "--metalink",
  "--mptcp",
  "--negotiate",
  "--no-alpn",
  "--no-keepalive",
  "--no-npn",
  "--no-proxy",
  "--no-sessionid",
  "--ntlm",
  "--ntlm-wb",
  "--oauth2-bearer",
  "--path-as-is",
  "--post301",
  "--post302",
  "--post303",
  "--proxy-insecure",
  "--proxy-negotiate",
  "--proxy-ntlm",
  "--proxy-ssl",
  "--proxy-ssl-allow-beast",
  "--proxy-ssl-auto-client-cert",
  "--proxy-tls13-ciphers",
  "--proxy-tlsauthtype",
  "--proxy-tlspassword",
  "--proxy-tlsuser",
  "--proxy-tlsv1",
  "--raw",
  "--redirect-url",
  "--remove-on-error",
  "--request-target",
  "--sasl-authzid",
  "--sasl-ir",
  "--ssl",
  "--ssl-allow-beast",
  "--ssl-auto-client-cert",
  "--ssl-no-revoke",
  "--ssl-reqd",
  "--ssl-revoke-best-effort",
  "--sslv2",
  "--sslv3",
  "--stderr",
  "--tcp-fastopen",
  "--tcp-nodelay",
  "--telnet-option",
  "--tftp-blksize",
  "--tftp-no-options",
  "--tls-max",
  "--tls13-ciphers",
  "--tlsauthtype",
  "--tlspassword",
  "--tlsuser",
  "--tlsv1",
  "--tlsv1.0",
  "--tlsv1.1",
  "--tlsv1.2",
  "--tlsv1.3",
  "--tr-encoding",
  "--use-ascii",
  "--xattr",
]);

/**
 * Wget options that take a value.
 */
const WGET_OPTIONS_WITH_VALUE = new Set([
  "-O",
  "--output-document",
  "-o",
  "--output-file",
  "-a",
  "--append-output",
  "-d",
  "--debug",
  "-v",
  "--verbose",
  "-B",
  "--base",
  "-e",
  "--execute",
  "--config",
  "--config-file",
  "-i",
  "--input-file",
  "-F",
  "--force-html",
  "-r",
  "--recursive",
  "-l",
  "--level",
  "-H",
  "--span-hosts",
  "-D",
  "--domains",
  "--exclude-domains",
  "--follow-tags",
  "--ignore-tags",
  "-A",
  "--accept",
  "-R",
  "--reject",
  "--accept-regex",
  "--reject-regex",
  "-X",
  "--exclude-directories",
  "-I",
  "--include-directories",
  "-nh",
  "--no-host-directories",
  "-nH",
  "--cut-dirs",
  "-P",
  "--directory-prefix",
  "-nc",
  "--no-clobber",
  "-c",
  "--continue",
  "--start-pos",
  "--progress",
  "--tries",
  "-t",
  "--retry-connrefused",
  "--timeout",
  "-T",
  "--dns-timeout",
  "--connect-timeout",
  "--read-timeout",
  "--write-timeout",
  "-w",
  "--wait",
  "--waitretry",
  "--random-wait",
  "--limit-rate",
  "-Q",
  "--quota",
  "--no-dns-cache",
  "--restrict-file-names",
  "-4",
  "--inet4-only",
  "-6",
  "--inet6-only",
  "--prefer-family",
  "--user",
  "--password",
  "--ask-password",
  "--use-askpass",
  "--ftp-user",
  "--ftp-password",
  "--no-passwd-ftp",
  "--proxy-user",
  "--proxy-password",
  "--header",
  "--http-user",
  "--http-password",
  "--no-http-keepalive",
  "--content-disposition",
  "--content-on-error",
  "--auth-no-challenge",
  "--secure-protocol",
  "--no-check-certificate",
  "--certificate",
  "--certificate-type",
  "--private-key",
  "--private-key-type",
  "--ca-certificate",
  "--ca-directory",
  "--crl-file",
  "--pinnedpubpin",
  "--random-file",
  "--egd-file",
  "--warc-file",
  "--warc-header",
  "--warc-max-size",
  "--warc-cdx",
  "--warc-dedup",
  "--warc-tempdir",
  "--no-warc-compression",
  "--no-warc-digests",
  "--no-warc-keep-log",
  "--warc-keep-log",
  "--metalink",
  "--metalink-over-http",
  "--preferred-location",
  "-S",
  "--server-response",
  "--spider",
  "-N",
  "--timestamping",
  "--start",
  "--stop",
  "--if-modified-since",
  "--no-use-server-timestamps",
  "-U",
  "--user-agent",
  "--referer",
  "-b",
  "--background",
  "-k",
  "--convert-links",
  "-K",
  "--backup-converted",
  "-m",
  "--mirror",
  "-p",
  "--page-requisites",
  "--strict-comments",
  "--default-page",
  "--adjust-extension",
  "-E",
  "--ignore-case",
  "-W",
  "--waitretry",
  "--random-wait",
  "--no-proxy",
  "--no-hsts",
  "--hsts-file",
  "--hsts",
  "--report-speed",
  "--restrict-file-names",
  "--cut-dirs",
  "--local-encoding",
  "--remote-encoding",
  "--unlink",
  "--xattr",
]);

/**
 * Wget standalone options (don't take a value).
 */
const WGET_STANDALONE_OPTIONS = new Set([
  "-h",
  "--help",
  "-V",
  "--version",
  "-b",
  "--background",
  "-d",
  "--debug",
  "-q",
  "--quiet",
  "-v",
  "--verbose",
  "-nv",
  "--non-verbose",
  "--no-verbose",
  "-r",
  "--recursive",
  "-H",
  "--span-hosts",
  "-nh",
  "--no-host-directories",
  "-nH",
  "-nc",
  "--no-clobber",
  "-c",
  "--continue",
  "-N",
  "--timestamping",
  "-S",
  "--server-response",
  "--spider",
  "-k",
  "--convert-links",
  "-K",
  "--backup-converted",
  "-m",
  "--mirror",
  "-p",
  "--page-requisites",
  "-E",
  "--adjust-extension",
  "--ignore-case",
  "--no-proxy",
  "--no-hsts",
  "--hsts",
  "--unlink",
  "--xattr",
  "--content-disposition",
  "--content-on-error",
  "--auth-no-challenge",
  "--no-check-certificate",
  "--no-dns-cache",
  "--inet4-only",
  "--inet6-only",
  "--no-http-keepalive",
  "--no-passwd-ftp",
  "--no-use-server-timestamps",
  "--no-warc-compression",
  "--no-warc-digests",
  "--no-warc-keep-log",
  "--warc-keep-log",
  "--metalink",
  "--metalink-over-http",
  "--strict-comments",
  "--secure-protocol",
]);

/**
 * Normalize an executable name (strip path and extension).
 */
function normalizeExecutableName(token: string | undefined): string {
  if (!token) {
    return "";
  }
  const base = normalizeLowercaseStringOrEmpty(token.split(/[\\/]/).at(-1));
  // Strip common extensions
  return base.replace(/\.(exe|cmd|bat|ps1|sh)$/u, "");
}

/**
 * Check if a token is a URL (starts with http:// or https://).
 */
function isHttpUrl(token: string): boolean {
  const trimmed = token.trim();
  return /^https?:\/\//i.test(trimmed);
}

/**
 * Extract hostname from a URL string.
 */
function extractHostnameFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    // Try to extract hostname from malformed URL
    const match = url.match(/^https?:\/\/([^/:#\s]+)/i);
    return match?.[1] ?? null;
  }
}

/**
 * Extract URLs from curl arguments.
 * Curl typically has URL as the last non-option argument, or after specific options.
 */
function extractUrlsFromCurlArgs(args: string[]): string[] {
  const urls: string[] = [];
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    // Skip options with values
    if (CURL_OPTIONS_WITH_VALUE.has(arg)) {
      i += 2; // Skip option and its value
      continue;
    }

    // Check option=value format (URL-bearing options)
    if (arg.includes("=")) {
      const [option, value] = arg.split("=");
      // curl --url= and -u= options contain URLs
      if (option === "--url" || option === "-u") {
        if (isHttpUrl(value)) {
          urls.push(value);
        }
      }
      i += 1;
      continue;
    }

    // Skip standalone options
    if (CURL_STANDALONE_OPTIONS.has(arg) || arg.startsWith("-")) {
      i += 1;
      continue;
    }

    // This might be a URL
    if (isHttpUrl(arg)) {
      urls.push(arg);
    }

    i += 1;
  }

  return urls;
}

/**
 * Extract URLs from wget arguments.
 * Wget typically has URL as the last non-option argument.
 */
function extractUrlsFromWgetArgs(args: string[]): string[] {
  const urls: string[] = [];
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    // Skip options with values
    if (WGET_OPTIONS_WITH_VALUE.has(arg)) {
      i += 2; // Skip option and its value
      continue;
    }

    // Skip standalone options
    if (WGET_STANDALONE_OPTIONS.has(arg) || arg.startsWith("-")) {
      i += 1;
      continue;
    }

    // Check option=value format
    if (arg.includes("=")) {
      // wget doesn't have URL-bearing options in this format, but skip safely
      i += 1;
      continue;
    }

    // This might be a URL
    if (isHttpUrl(arg)) {
      urls.push(arg);
    }

    i += 1;
  }

  return urls;
}

/**
 * Extract URLs from generic network tool arguments.
 * For unknown tools, look for any http(s) URL in the arguments.
 */
function extractUrlsFromGenericArgs(args: string[]): string[] {
  return args.filter(isHttpUrl);
}

/**
 * Extract URLs from a network tool command segment.
 */
function extractUrlsFromSegment(segment: ExecCommandSegment): string[] {
  const argv = segment.argv;
  if (argv.length === 0) {
    return [];
  }

  const executable = normalizeExecutableName(argv[0]);
  const args = argv.slice(1);

  if (executable === "curl" || executable === "curlie") {
    return extractUrlsFromCurlArgs(args);
  }

  if (executable === "wget") {
    return extractUrlsFromWgetArgs(args);
  }

  // For other network tools, use generic extraction
  return extractUrlsFromGenericArgs(argv);
}

/**
 * Check if a segment uses a known network tool.
 */
function isNetworkToolSegment(segment: ExecCommandSegment): boolean {
  const executable = normalizeExecutableName(segment.argv[0]);
  return NETWORK_TOOLS.has(executable);
}

/**
 * Filter result indicating whether the command is allowed or blocked.
 */
export type ExecSsrfFilterResult =
  | {
      allowed: true;
    }
  | {
      allowed: false;
      reason: string;
      blockedHost: string;
      blockedUrl: string;
    };

/**
 * Filter an exec command for SSRF violations.
 * Parses the command, extracts URLs from network tools, and checks each URL's hostname.
 *
 * @param command - The shell command to filter
 * @param policy - Optional SSRF policy (defaults to blocking private IPs/hostnames)
 * @returns Filter result indicating whether the command is allowed or blocked
 */
export function filterExecCommandSsrF(params: {
  command: string;
  policy?: SsrFPolicy;
}): ExecSsrfFilterResult {
  const { command, policy } = params;

  // Analyze the shell command to get segments
  const analysis = analyzeShellCommand({ command });

  if (!analysis.ok) {
    // If we can't parse the command, fail closed for security
    // Unknown shell syntax could hide blocked destinations (command substitution, etc.)
    return {
      allowed: false,
      reason: "Unable to parse shell command for SSRF validation",
    };
  }

  // Check each segment for network tools
  for (const segment of analysis.segments) {
    if (!isNetworkToolSegment(segment)) {
      continue;
    }

    const urls = extractUrlsFromSegment(segment);

    for (const url of urls) {
      const hostname = extractHostnameFromUrl(url);
      if (!hostname) {
        continue;
      }

      if (isBlockedHostnameOrIp(hostname, policy)) {
        return {
          allowed: false,
          reason: "Blocked hostname or private/internal/special-use IP address",
          blockedHost: hostname,
          blockedUrl: url,
        };
      }
    }
  }

  return { allowed: true };
}

/**
 * Validate an exec command for SSRF violations.
 * Throws SsrFBlockedError if a blocked hostname/IP is detected.
 *
 * @param command - The shell command to validate
 * @param policy - Optional SSRF policy
 * @throws SsrFBlockedError if blocked hostname/IP detected
 */
export function validateExecCommandSsrF(params: { command: string; policy?: SsrFPolicy }): void {
  const result = filterExecCommandSsrF(params);

  if (!result.allowed) {
    throw new SsrFBlockedError(
      `${result.reason} (host: ${result.blockedHost}, url: ${result.blockedUrl})`,
    );
  }
}

// Export for testing
export const __testing = {
  normalizeExecutableName,
  isHttpUrl,
  extractHostnameFromUrl,
  extractUrlsFromCurlArgs,
  extractUrlsFromWgetArgs,
  extractUrlsFromGenericArgs,
  extractUrlsFromSegment,
  isNetworkToolSegment,
  NETWORK_TOOLS,
};
