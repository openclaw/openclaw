"""
Simple test script to verify SotyBot MVP functionality
"""

import asyncio
from engine.agents.registry import registry


async def test_agent_discovery():
    """Test agent discovery"""
    print("[*] Discovering agents...")
    agents = registry.discover_agents()
    print(f"[+] Found {len(agents)} agents:")
    for agent in agents:
        print(f"  - {agent}")
    print()


async def test_load_creative_agent():
    """Test loading creative agent"""
    print("[*] Loading creative writer agent...")
    try:
        agent = await registry.load_agent("creative/content_generator")
        print(f"[+] Loaded: {agent.name}")
        print(f"  Domain: {agent.domain}")
        print(f"  Risk Level: {agent.risk_level.value}")
        print(f"  Capabilities: {len(agent.get_capabilities())}")
        print()
        return True
    except Exception as e:
        print(f"[-] Failed: {e}")
        return False


async def test_execute_creative_task():
    """Test executing a creative task"""
    print("[*] Executing creative task...")
    try:
        result = await registry.execute_agent(
            "creative_writer",
            "generate blog ideas about open source AI"
        )
        print("[+] Task completed!")
        print(f"  Generated {len(result.get('ideas', []))} ideas")
        if result.get('ideas'):
            print("  First idea:", result['ideas'][0])
        print()
        return True
    except Exception as e:
        print(f"[-] Failed: {e}")
        return False


async def test_load_security_agent():
    """Test loading security agent"""
    print("[*] Loading security threat analyzer...")
    try:
        agent = await registry.load_agent("security/threat_analyzer")
        print(f"[+] Loaded: {agent.name}")
        print(f"  Domain: {agent.domain}")
        print(f"  Capabilities: {len(agent.get_capabilities())}")
        print()
        return True
    except Exception as e:
        print(f"[-] Failed: {e}")
        return False


async def test_execute_security_task():
    """Test executing a security task"""
    print("[*] Executing security analysis...")
    try:
        result = await registry.execute_agent(
            "threat_analyzer",
            "analyze hash 5d41402abc4b2a76b9719d911017c592"
        )
        print("[+] Analysis completed!")
        print(f"  Hash Type: {result.get('hash_type')}")
        print(f"  Verdict: {result.get('verdict', {}).get('severity')}")
        print()
        return True
    except Exception as e:
        print(f"[-] Failed: {e}")
        return False


async def main():
    """Run all tests"""
    print("=" * 60)
    print("SotyBot MVP - Functionality Test")
    print("=" * 60)
    print()
    
    results = []
    
    # Test discovery
    await test_agent_discovery()
    
    # Test creative agent
    results.append(await test_load_creative_agent())
    results.append(await test_execute_creative_task())
    
    # Test security agent
    results.append(await test_load_security_agent())
    results.append(await test_execute_security_task())
    
    # Summary
    print("=" * 60)
    print(f"Test Results: {sum(results)}/{len(results)} passed")
    print("=" * 60)
    
    if all(results):
        print("[SUCCESS] All tests passed! SotyBot MVP is working!")
    else:
        print("[WARNING] Some tests failed. Check errors above.")


if __name__ == "__main__":
    asyncio.run(main())
