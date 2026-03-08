from mcp.server.fastmcp import FastMCP
import subprocess
import json

mcp = FastMCP("Read-Only Parsers")

@mcp.tool()
def run_ripgrep(query: str, path: str) -> str:
    """Run ripgrep in read-only mode to search for a regex in files."""
    try:
        result = subprocess.run(
            ["rg", "--no-heading", "--line-number", query, path],
            capture_output=True, text=True, timeout=10
        )
        return result.stdout if result.stdout else "No matches found."
    except Exception as e:
        return f"Error running ripgrep: {e}"

@mcp.tool()
def run_jq(filter_string: str, json_content: str) -> str:
    """Run jq to parse JSON content safely."""
    try:
        result = subprocess.run(
            ["jq", filter_string],
            input=json_content,
            capture_output=True, text=True, timeout=5
        )
        return result.stdout if result.returncode == 0 else result.stderr
    except Exception as e:
        return f"Error running jq: {e}"

@mcp.tool()
def run_yq(filter_string: str, yaml_content: str) -> str:
    """Run yq to parse YAML content safely."""
    try:
        result = subprocess.run(
            ["yq", filter_string],
            input=yaml_content,
            capture_output=True, text=True, timeout=5
        )
        return result.stdout if result.returncode == 0 else result.stderr
    except Exception as e:
        return f"Error running yq: {e}"

if __name__ == "__main__":
    mcp.run()
