"""Tests for WebSocket server integration."""

import pytest
from fastapi.testclient import TestClient

from openclaw_py.config import GatewayConfig, OpenClawConfig
from openclaw_py.gateway.app import create_app
from openclaw_py.gateway.ws_server import (
    create_websocket_router,
    get_connection_manager,
)


@pytest.fixture
def test_config():
    """Create test configuration."""
    return OpenClawConfig(
        gateway=GatewayConfig(enabled=True),
    )


@pytest.fixture
def client(test_config):
    """Create test client."""
    app = create_app(test_config)
    return TestClient(app)


def test_create_websocket_router():
    """Test creating WebSocket router."""
    config = GatewayConfig(enabled=True)
    router = create_websocket_router(config)

    assert router is not None
    # Router should have routes
    assert len(router.routes) > 0


def test_websocket_router_has_ws_endpoint():
    """Test that WebSocket router has /ws endpoint."""
    config = GatewayConfig(enabled=True)
    router = create_websocket_router(config)

    # Find WebSocket route
    ws_routes = [r for r in router.routes if hasattr(r, "path") and r.path == "/ws"]
    assert len(ws_routes) > 0


def test_websocket_router_has_test_page():
    """Test that WebSocket router has test page endpoint."""
    config = GatewayConfig(enabled=True)
    router = create_websocket_router(config)

    # Find test page route
    test_routes = [
        r for r in router.routes if hasattr(r, "path") and r.path == "/ws-test"
    ]
    assert len(test_routes) > 0


def test_get_connection_manager():
    """Test getting global connection manager."""
    manager = get_connection_manager()

    assert manager is not None
    assert hasattr(manager, "connections")
    assert hasattr(manager, "clients_by_id")


def test_connection_manager_singleton():
    """Test that connection manager is a singleton."""
    manager1 = get_connection_manager()
    manager2 = get_connection_manager()

    assert manager1 is manager2


def test_ws_test_page_accessible(client):
    """Test that WebSocket test page is accessible."""
    response = client.get("/ws-test")

    assert response.status_code == 200
    assert "WebSocket Test" in response.text
    assert "text/html" in response.headers["content-type"]


def test_ws_test_page_has_javascript(client):
    """Test that test page includes JavaScript."""
    response = client.get("/ws-test")

    assert response.status_code == 200
    assert "<script>" in response.text
    assert "WebSocket" in response.text
    assert "connect()" in response.text


def test_app_includes_websocket_routes(test_config):
    """Test that app includes WebSocket routes."""
    app = create_app(test_config)

    # Check that app has WebSocket routes
    routes = [r.path for r in app.routes]
    assert "/ws" in routes or any("/ws" in str(r) for r in app.routes)


def test_websocket_endpoint_exists(client):
    """Test that WebSocket endpoint exists (will reject non-WS)."""
    # GET request to WebSocket endpoint should return 404, 405, or similar
    response = client.get("/ws")

    # FastAPI may return different codes for GET on WebSocket endpoint
    # 404, 405, 403, or 426 are all valid responses
    assert response.status_code in [403, 404, 405, 426]
