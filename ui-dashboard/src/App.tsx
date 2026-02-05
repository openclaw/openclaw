import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Header } from './components/layout/Header';
import { ChatView, SettingsView, PlaceholderView } from './views';
import './styles/global.css';
import './App.css';

function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <Header />
        <Routes>
          <Route path="/" element={<ChatView />} />
          <Route path="/board" element={<PlaceholderView title="Board" description="Kanban-style task management with drag-and-drop" />} />
          <Route path="/git" element={<PlaceholderView title="Git" description="Commit graph, branches, and worktree management" />} />
          <Route path="/files" element={<PlaceholderView title="Files" description="Browse and explore project files with syntax highlighting" />} />
          <Route path="/timeline" element={<PlaceholderView title="Timeline" description="Chronological activity feed with all events" />} />
          <Route path="/settings" element={<SettingsView />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

export default App;
