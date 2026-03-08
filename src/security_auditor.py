import re
from typing import Optional


class SecurityAuditor:
    """
    Brigade: Dmarket
    Role: Security Auditor
    Model Constraint: llama3.1:8b (8GB VRAM shared)
    
    Scans outputs and logs for hardcoded API keys, environment variables,
    and sensitive tokens before they are saved or broadcasted to Telegram.
    """
    
    # Common patterns for sensitive keys (DumpsterDiver/Gitleaks style)
    PATTERNS = [
        re.compile(r"(?i)(?:api_key|apikey|secret|token|password|t_token|auth)[=:\s]+['\"]?([a-zA-Z0-9\-_]{16,})['\"]?"),
        re.compile(r"(?i)sk-[a-zA-Z0-9]{32,}"),  # typical OpenAI/generic secret key
        re.compile(r"(?i)Bearer\s+[a-zA-Z0-9\-\._~+\/]+=*"), # JWT / Bearer tokens
        re.compile(r"(?i)dmarket_[a-zA-Z0-9]{20,}"), # Dmarket specific (mock pattern)
        re.compile(r"(?i)[\w-]+\.env"), # mentions of .env files being dumped
        re.compile(r"(?i)-----BEGIN\s+(?:RSA|OPENSSH|PGP|DSA|EC)\s+PRIVATE\s+KEY-----"), # Private keys
        re.compile(r"(?i)(?:ghp_|github_pat_)[a-zA-Z0-9_]{36,}"), # Github tokens
        re.compile(r"(?i)xox[baprs]-[0-9]+-[0-9]+-[a-zA-Z0-9]+"), # Slack tokens
        re.compile(r"(?i)bot[0-9]+:[a-zA-Z0-9_-]{35,}"), # Telegram bot tokens
    ]

    # Patterns indicating potential prompt injection or system prompt leakage attempts
    PROMPT_INJECTION_PATTERNS = [
        re.compile(r"(?i)(ignore\s+all\s+previous\s+instructions|disregard\s+all)"),
        re.compile(r"(?i)(you\s+are\s+now|act\s+as\s+if)\s+(you\s+are\s+not|you\s+can\s+do\s+anything)"),
        re.compile(r"(?i)(print|show|output)\s+(your\s+)?(system\s+prompt|instructions)"),
    ]

    @classmethod
    def scan_for_leaks(cls, text: str) -> bool:
        """
        Scans the text for potential security leaks and basic prompt injections.
        Returns True if a leak or injection attempt is detected, False otherwise.
        """
        for pattern in cls.PATTERNS + cls.PROMPT_INJECTION_PATTERNS:
            if pattern.search(text):
                return True
        return False

    @classmethod
    def sanitize(cls, text: str) -> str:
        """
        Redacts detected sensitive information or blocks prompt injections.
        """
        sanitized_text = text
        
        for pattern in cls.PROMPT_INJECTION_PATTERNS:
            if pattern.search(text):
                return "[BLOCKED_BY_SECURITY_AUDITOR: PROMPT_INJECTION_DETECTED]"

        for pattern in cls.PATTERNS:
            # Replace the captured group or the whole match with REDACTED
            sanitized_text = pattern.sub("[REDACTED_BY_SECURITY_AUDITOR]", sanitized_text)
        return sanitized_text

# ======= Example Usage =======
if __name__ == "__main__":
    test_log = "Error in connection. Using api_key = 'sk-1234567890abcdef1234567890abcdef12' for retry."
    if SecurityAuditor.scan_for_leaks(test_log):
        print("Leak detected! Sanitizing...")
        safe_log = SecurityAuditor.sanitize(test_log)
        print(f"Safe Log: {safe_log}")
